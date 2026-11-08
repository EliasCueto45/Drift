import { randomUUID } from 'node:crypto';
import { collection,datasetTime } from './database.mjs';
import { activeCloud, cloudRecord, contains, expireMessage, geometryValid, messageRecord, publicMessage, saveCloud } from './records.mjs';
import { exact, fail, messageInput, outlineVertices, requireThat, validate } from './validation.mjs';
import { rateLimit } from './auth.mjs';
import { artworkCorners,distanceM,pointGeometry } from './geometry.mjs';

export async function createMessage(db, cloudId, input, user) {
  messageInput(input);
  const c = await activeCloud(db,cloudId,input.expectedCloudVersion);
  await contains(db,cloudId,input.anchor);
  await rateLimit(db,user.id,'post',10);
  let asset;
  if (input.assetId) {
    asset = await collection(db,'assets').findOne({_id:input.assetId});
    requireThat(asset && asset.owner_id === user.id, 'Owned asset required', 'FORBIDDEN',403);
    requireThat(asset.payload.state === 'ready' && asset.payload.kind === input.kind && !asset.attached_message_id, 'Ready unused asset of matching kind required');
  }
  const at = c.ds.clock.toISOString(), id = randomUUID();
  const artwork = input.artworkTransform ? { ...input.artworkTransform } : null;
  if (artwork) {
    // Four corners define the rectangle in world coordinates. Caller-supplied
    // control points cannot smuggle unrelated geographic coordinates.
    artwork.controlPoints=artworkCorners(input.anchor,artwork);
  }
  const msg = validate('Message',{id,version:1,cloudId,authorId:user.id,kind:input.kind,anchor:input.anchor,createdAt:at,updatedAt:at,expiredAt:null,voteCount:0,viewerHasUpvoted:false,body:input.body??null,assetId:input.assetId??null,songUrl:input.songUrl??null,artworkTransform:artwork});
  await collection(db,'messages').insertOne({_id:id,id,cloud_id:cloudId,author_id:user.id,asset_id:input.assetId??null,payload:msg,anchor:pointGeometry(input.anchor),strokes:input.strokes??null,position_at:new Date(at),expired_at:null,held:false});
  if(asset)await collection(db,'assets').updateOne({_id:asset.id},{$set:{attached_message_id:id}});
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
  const existing=await collection(db,'votes').findOne({message_id:id,user_id:user.id});
  if (!!existing !== input.active) {
    await rateLimit(db,user.id,'vote',60);
    if(input.active)await collection(db,'votes').insertOne({_id:JSON.stringify([id,user.id]),message_id:id,user_id:user.id});
    else await collection(db,'votes').deleteOne({message_id:id,user_id:user.id});
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
  for(const [longitude,latitude]of vertices)for(const [lng,lat]of vertices) requireThat(distanceM({longitude,latitude},{longitude:lng,latitude:lat})<=10000,'Outline diameter exceeds 10 km');
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
    await collection(db,'clouds').updateOne({_id:id},{$set:{deleted_at:db.now??new Date()}});
    for(const m of await collection(db,'messages').find({cloud_id:id}).toArray())await expireMessage(db,m.id,at);
  }
  return {data:{id,expired:true}};
}
