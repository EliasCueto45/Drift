import { cloudRecord, publicMessage, successors } from './records.mjs';
import { snapshotPage } from './pagination.mjs';
import { location, radius, limit, requireThat } from './validation.mjs';
import { collection,datasetTime } from './database.mjs';
import { footprintDistanceM } from './geometry.mjs';

export function skyFreshness(dataset, clouds, now = Date.now()) {
  if (dataset.mode === 'replay') return 'replay';
  const age = now - new Date(dataset.observed_at).getTime();
  // Receipt/download time never makes an old satellite observation current.
  if (age > 1800000) return 'stale';
  if (age < 0 || age > 600000) return 'estimated';
  const observed = clouds.filter(c => c.kind === 'observed');
  if (clouds.length && !observed.length) return 'estimated';
  return observed.every(c => {
    const cloudAge = now - Date.parse(c.observedAt);
    return c.status === 'active' && c.confidence >= 0.5 && cloudAge >= 0 && cloudAge <= 600000;
  }) ? 'live' : 'estimated';
}

export async function rankedIds(db, cloudId, anchor, distance) {
  const match={cloud_id:cloudId,expired_at:null,held:false};
  if(anchor)match.anchor={$geoWithin:{$centerSphere:[[anchor.longitude,anchor.latitude],distance/6371008.8]}};
  return (await collection(db,'messages').aggregate([
    {$match:match},{$lookup:{from:'votes',localField:'id',foreignField:'message_id',as:'rankingVotes'}},
    {$set:{rankingCount:{$size:'$rankingVotes'}}},{$sort:{rankingCount:-1,'payload.createdAt':-1,id:1}},{$project:{id:1}}
  ],{collation:{locale:'simple'}}).toArray()).map(r=>r.id);
}
export async function messagePage(db, id, params, viewer) {
  await cloudRecord(db,id);
  const scope = params.get('scope') ?? 'nearby';
  requireThat(['nearby','all'].includes(scope), 'scope must be nearby or all');
  const anchor = scope === 'nearby' ? location(params) : null, distance = radius(params), size = limit(params);
  const binding = JSON.stringify(['messages',id,scope,anchor,distance,viewer?.id ?? null,size]);
  const page = await snapshotPage(db,binding,params.get('cursor'),async () => ({items: await rankedIds(db,id,anchor,distance)}),size);
  const data = [];
  for (const key of page.items) {
    const row = await collection(db,'messages').findOne({_id:key,cloud_id:id});
    if (row) { const m = await publicMessage(db,row,viewer?.id); if (m) data.push(m); }
  }
  return { data, nextCursor: page.nextCursor };
}
export async function sky(db, params, viewer) {
  const anchor = location(params), distance = radius(params), size = limit(params), dsId = params.get('datasetId');
  requireThat(dsId, 'datasetId required');
  const ds = await datasetTime(db,dsId);
  if (!ds) return {data:{clouds:[],asOf:new Date().toISOString(),weather:null,freshness:'stale'},nextCursor:null};
  const binding = JSON.stringify(['sky',dsId,anchor,distance,viewer?.id ?? null,size]);
  const page = await snapshotPage(db,binding,params.get('cursor'),async () => {
    // Regional MVP: test exact geodesic distance to the footprint, including
    // points inside overcast cover. Centroid distance would lose distant notes.
    const ids=(await collection(db,'clouds').find({dataset_id:dsId}).sort({id:1}).toArray()).filter(c=>footprintDistanceM(c.footprint,anchor)<=distance).map(c=>c.id);
    const items = [];
    for (const id of ids) {
      const c = await cloudRecord(db,id);
      if (!c.expired && c.payload.status !== 'out_of_region') items.push({id,previews:(await rankedIds(db,id,anchor,distance)).slice(0,3)});
    }
    return {items};
  },size);
  const clouds = [];
  for (const item of page.items) {
    const c = await cloudRecord(db,item.id);
    if (c.expired || c.payload.status === 'out_of_region') continue;
    const previews = [];
    for (const id of item.previews) {
      const row = await collection(db,'messages').findOne({_id:id,cloud_id:item.id});
      if (row) { const m = await publicMessage(db,row,viewer?.id); if (m) previews.push(m); }
    }
    clouds.push({cloud:c.payload,previews});
  }
  return {data:{clouds,asOf:ds.observed_at.toISOString(),freshness:skyFreshness(ds,clouds.map(item=>item.cloud)),weather:null},nextCursor:page.nextCursor};
}
export async function cloudDetail(db,id) {
  const c = await cloudRecord(db,id);
  const lifecycle=(await collection(db,'lifecycle_events').find({$or:[{'payload.sourceCloudIds':id},{'payload.targetCloudIds':id}]}).sort({'payload.effectiveAt':1,_id:1}).toArray()).map(r=>r.payload);
  const successorIds = await successors(db,id);
  return {data:c.expired ? {id,status:'expired',lifecycle,successorIds} : {cloud:c.payload,lifecycle,successorIds}};
}
