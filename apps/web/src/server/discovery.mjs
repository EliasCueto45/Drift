import { cloudRecord, publicMessage, successors } from './records.mjs';
import { snapshotPage } from './pagination.mjs';
import { location, radius, limit, requireThat } from './validation.mjs';
import { datasetTime } from './database.mjs';

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
  return (await db.query(`SELECT m.id FROM messages m LEFT JOIN votes v ON v.message_id=m.id
    WHERE m.cloud_id=$1 AND m.expired_at IS NULL AND NOT m.held
    AND ($2::float8 IS NULL OR ST_DWithin(m.anchor::geography,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4))
    GROUP BY m.id ORDER BY count(v.user_id) DESC, m.payload->>'createdAt' DESC,m.id COLLATE "C" ASC`, [cloudId,anchor?.longitude ?? null,anchor?.latitude ?? null,distance])).rows.map(r => r.id);
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
    const row = (await db.query('SELECT * FROM messages WHERE id=$1 AND cloud_id=$2', [key,id])).rows[0];
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
    const ids = (await db.query(`SELECT id FROM clouds WHERE dataset_id=$1 AND ST_DWithin(footprint::geography,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4) ORDER BY id COLLATE "C"`, [dsId,anchor.longitude,anchor.latitude,distance])).rows.map(r => r.id);
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
      const row = (await db.query('SELECT * FROM messages WHERE id=$1 AND cloud_id=$2',[id,item.id])).rows[0];
      if (row) { const m = await publicMessage(db,row,viewer?.id); if (m) previews.push(m); }
    }
    clouds.push({cloud:c.payload,previews});
  }
  return {data:{clouds,asOf:ds.observed_at.toISOString(),freshness:skyFreshness(ds,clouds.map(item=>item.cloud)),weather:null},nextCursor:page.nextCursor};
}
export async function cloudDetail(db,id) {
  const c = await cloudRecord(db,id);
  const lifecycle = (await db.query(`SELECT payload FROM lifecycle_events WHERE payload->'sourceCloudIds' ? $1 OR payload->'targetCloudIds' ? $1 ORDER BY payload->>'effectiveAt',event_id`,[id])).rows.map(r=>r.payload);
  const successorIds = await successors(db,id);
  return {data:c.expired ? {id,status:'expired',lifecycle,successorIds} : {cloud:c.payload,lifecycle,successorIds}};
}
