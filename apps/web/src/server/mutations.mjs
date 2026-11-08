import { randomUUID } from 'node:crypto';
import { one, datasetTime } from './database.mjs';
import { activeCloud, cloudRecord, contains, expireMessage, geometryValid, messageRecord, publicMessage, saveCloud } from './records.mjs';
import { exact, fail, messageInput, outlineVertices, requireThat, validate } from './validation.mjs';
import { rateLimit } from './auth.mjs';

export async function createMessage(db, cloudId, input, user) {
  messageInput(input);
  const c = await activeCloud(db,cloudId,input.expectedCloudVersion);
  await contains(db,cloudId,input.anchor);
  await rateLimit(db,user.id,'post',10);
  let asset;
  if (input.assetId) {
    asset = await one(db,'SELECT * FROM assets WHERE id=$1',[input.assetId]);
    requireThat(asset && asset.owner_id === user.id, 'Owned asset required', 'FORBIDDEN',403);
    requireThat(asset.payload.state === 'ready' && asset.payload.kind === input.kind && !asset.attached_message_id, 'Ready unused asset of matching kind required');
  }
  const at = c.ds.clock.toISOString(), id = randomUUID();
  const artwork = input.artworkTransform ? { ...input.artworkTransform } : null;
  if (artwork) {
    // Four corners define the rectangle in world coordinates. Caller-supplied
    // control points cannot smuggle unrelated geographic coordinates.
    const {longitude:lon,latitude:lat} = input.anchor;
    const theta = artwork.rotationDeg * Math.PI/180;
    const controls = [];
    for (const [x,y] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      const east = x*artwork.widthM/2*Math.cos(theta)+y*artwork.heightM/2*Math.sin(theta);
      const north = -x*artwork.widthM/2*Math.sin(theta)+y*artwork.heightM/2*Math.cos(theta);
      const p = await one(db,`SELECT ST_X(g) AS longitude,ST_Y(g) AS latitude FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3::float8,$4::float8)::geometry g) q`,[lon,lat,Math.hypot(east,north),Math.atan2(east,north)]);
      controls.push(p);
    }
    artwork.controlPoints = controls;
  }
  const msg = validate('Message',{id,version:1,cloudId,authorId:user.id,kind:input.kind,anchor:input.anchor,createdAt:at,updatedAt:at,expiredAt:null,voteCount:0,viewerHasUpvoted:false,body:input.body??null,assetId:input.assetId??null,songUrl:input.songUrl??null,artworkTransform:artwork});
  await db.query(`INSERT INTO messages(id,cloud_id,author_id,asset_id,payload,anchor,strokes,position_at)
    VALUES($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($6,$7),4326),$8,$9)`,[id,cloudId,user.id,input.assetId??null,msg,input.anchor.longitude,input.anchor.latitude,input.strokes?JSON.stringify(input.strokes):null,at]);
  if (asset) await db.query('UPDATE assets SET attached_message_id=$2 WHERE id=$1',[asset.id,id]);
  return {data:msg};
}
export async function deleteMessage(db,id,user) {
  const row = await messageRecord(db,id);
  requireThat(row.author_id === user.id,'Author only','FORBIDDEN',403);
  const c = await cloudRecord(db,row.cloud_id);
  await expireMessage(db,id,c.ds.clock.toISOString());
  return {data:{id,expired:true}};
}
export async function upvote(db,id,input,user) {
  exact(input,['active']); requireThat(typeof input.active === 'boolean','active must be boolean');
  const row = await messageRecord(db,id);
  if (!await publicMessage(db,row,user.id)) fail(410,'CLOUD_EXPIRED','Message unavailable');
  const existing = await one(db,'SELECT 1 FROM votes WHERE message_id=$1 AND user_id=$2',[id,user.id]);
  if (!!existing !== input.active) {
    await rateLimit(db,user.id,'vote',60);
    if (input.active) await db.query('INSERT INTO votes(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,user.id]);
    else await db.query('DELETE FROM votes WHERE message_id=$1 AND user_id=$2',[id,user.id]);
  }
  // Voting does not move the parcel or invalidate worker anchor versions.
  const msg = await publicMessage(db,row,user.id);
  return {data:{voteCount:msg.voteCount,viewerHasUpvoted:msg.viewerHasUpvoted}};
}
export async function createCloud(db,input,user) {
  exact(input,['outline','assumedAltitudeM']); validate('CreateCloudRequest',input);
  const vertices = outlineVertices(input.outline);
  await geometryValid(db,input.outline);
  // Pairwise geodesic distances enforce diameter, including diagonal vertices.
  const extent = await one(db,`WITH p AS (SELECT ST_SetSRID(ST_MakePoint((v->>0)::float8,(v->>1)::float8),4326)::geography g FROM jsonb_array_elements($1::jsonb) v)
    SELECT max(ST_Distance(a.g,b.g)) AS diameter FROM p a CROSS JOIN p b`,[JSON.stringify(vertices)]);
  requireThat(extent.diameter <= 10000,'Outline diameter exceeds 10 km');
  const dsId = process.env.DRIFT_DATASET_ID;
  if (!dsId) fail(503,'NOT_CONFIGURED','DRIFT_DATASET_ID required');
  const ds = await datasetTime(db,dsId);
  if (!ds) fail(409,'DATASET_NOT_READY','Initialize dataset before creating clouds');
  await rateLimit(db,user.id,'post',10);
  const at = ds.clock.toISOString();
  const cloud = validate('Cloud',{id:randomUUID(),version:1,kind:'created',status:'active',geometry:{type:'MultiPolygon',coordinates:[input.outline.coordinates]},observedAt:at,updatedAt:at,confidence:0,wind:{uMps:0,vMps:0,altitudeM:2000,source:'estimated:awaiting-wind',validAt:at,confidence:0},parentIds:[],creatorId:user.id,expiresAt:new Date(ds.clock.getTime()+86400000).toISOString(),datasetId:dsId,trackingRunId:ds.run_id});
  await saveCloud(db,cloud);
  return {data:cloud};
}
export async function deleteCloud(db,id,user) {
  const c = await cloudRecord(db,id);
  requireThat(c.payload.kind === 'created' && c.payload.creatorId === user.id,'Created cloud creator only','FORBIDDEN',403);
  if (!c.deleted_at) {
    const at = c.ds.clock.toISOString();
    await saveCloud(db,{...c.payload,status:'expired',version:c.payload.version+1,updatedAt:at});
    await db.query('UPDATE clouds SET deleted_at=now() WHERE id=$1',[id]);
    for (const m of (await db.query('SELECT id FROM messages WHERE cloud_id=$1',[id])).rows) await expireMessage(db,m.id,at);
  }
  return {data:{id,expired:true}};
}
