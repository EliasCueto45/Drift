import { collection,datasetTime } from './database.mjs';
import { fail,requireThat } from './validation.mjs';
import { covers,validateGeometry } from './geometry.mjs';

export async function cloudRecord(db,id) {
  const c=await collection(db,'clouds').findOne({_id:id});
  if(!c)fail(404,'NOT_FOUND','Cloud not found');
  const ds=await datasetTime(db,c.dataset_id);
  const elapsed=c.payload.expiresAt&&Date.parse(c.payload.expiresAt)<=ds.clock.getTime();
  return {...c,ds,expired:!!c.deleted_at||c.payload.status==='expired'||!!elapsed};
}
export async function successors(db,id){return (await collection(db,'clouds').find({'payload.parentIds':id}).sort({id:1}).toArray()).map(c=>c.id);}
export async function activeCloud(db,id,version){
  const c=await cloudRecord(db,id),next=await successors(db,id);
  if(next.length)fail(409,'CLOUD_RETIRED',`Cloud retired; successor IDs: ${JSON.stringify(next)}`);
  if(c.expired)fail(410,'CLOUD_EXPIRED','Cloud expired');
  requireThat(c.payload.status==='active','Cloud is not eligible for posting','CLOUD_UNAVAILABLE',409);
  if(version!==undefined)requireThat(c.payload.version===version,'Cloud version changed','VERSION_CONFLICT',409);
  return c;
}
export async function saveCloud(db,cloud){
  validateGeometry(cloud.geometry);
  await collection(db,'clouds').updateOne({_id:cloud.id},{$set:{id:cloud.id,dataset_id:cloud.datasetId,payload:cloud,footprint:cloud.geometry},$setOnInsert:{deleted_at:null}},{upsert:true});
  await collection(db,'cloud_history').insertOne({_id:JSON.stringify([cloud.id,cloud.version]),cloud_id:cloud.id,version:cloud.version,payload:cloud});
}
export async function contains(db,id,anchor){
  const c=await collection(db,'clouds').findOne({_id:id});
  requireThat(c&&covers(c.footprint,anchor),'Anchor must be inside cloud footprint');
}
export async function geometryValid(_db,geometry){validateGeometry(geometry);}
export async function messageRecord(db,id){
  const m=await collection(db,'messages').findOne({_id:id});if(!m)fail(404,'NOT_FOUND','Message not found');return m;
}
export async function publicMessage(db,row,viewerId){
  const c=await cloudRecord(db,row.cloud_id);
  if(row.expired_at||row.held||c.expired||c.payload.status==='out_of_region')return null;
  const votes=collection(db,'votes');
  return {...row.payload,voteCount:await votes.countDocuments({message_id:row.id}),viewerHasUpvoted:!!viewerId&&!!await votes.findOne({message_id:row.id,user_id:viewerId})};
}
export async function expireMessage(db,id,at){
  const row=await collection(db,'messages').findOne({_id:id});if(!row)return;
  if(!row.expired_at)await collection(db,'messages').updateOne({_id:id},{$set:{expired_at:new Date(at),'payload.expiredAt':at,'payload.updatedAt':at},$inc:{'payload.version':1}});
  await collection(db,'cleanup_jobs').updateOne({_id:id},{$setOnInsert:{message_id:id,queued_at:db.now??new Date(),attempts:0}},{upsert:true});
}
