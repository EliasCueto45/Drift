import { collection,datasetTime } from './database.mjs';
import { expireMessage } from './records.mjs';
import { storageClient,objectCommand,DeleteObjectCommand } from './storage.mjs';

export async function cleanup(db,makeClient=storageClient,batchSize=100){
  const clouds=await collection(db,'clouds').find({$or:[{deleted_at:{$ne:null}},{'payload.expiresAt':{$type:'string'}}]}).toArray();
  let remaining=batchSize;
  for(const c of clouds){
    if(remaining<=0)break;
    const ds=await datasetTime(db,c.dataset_id);
    if(!c.deleted_at&&Date.parse(c.payload.expiresAt)>ds.clock.getTime())continue;
    for(const m of await collection(db,'messages').find({cloud_id:c.id,expired_at:null}).limit(remaining).toArray()){
      await expireMessage(db,m.id,ds.clock.toISOString());remaining--;
    }
  }
  let completed=0,failed=0;
  for(const job of await collection(db,'cleanup_jobs').find().sort({queued_at:1}).limit(batchSize).toArray()){
    const m=await collection(db,'messages').findOne({_id:job.message_id});
    if(!m){await collection(db,'cleanup_jobs').deleteOne({_id:job._id});continue;}
    const asset=m.asset_id?await collection(db,'assets').findOne({_id:m.asset_id}):null;
    try {
      // Deterministic DeleteObject keys are idempotent when a transaction retries.
      if(asset){const client=makeClient();await client.send(objectCommand(DeleteObjectCommand,asset.upload_key));await client.send(objectCommand(DeleteObjectCommand,asset.object_key));}
    }catch{
      await collection(db,'cleanup_jobs').updateOne({_id:job._id},{$inc:{attempts:1}});failed++;continue;
    }
    if(asset)await collection(db,'assets').updateOne({_id:asset.id},{$set:{'payload.state':'deleted',attached_message_id:null,staging_deleted:true}});
    await collection(db,'votes').deleteMany({message_id:m.id});
    await collection(db,'messages').deleteOne({_id:m.id});
    await collection(db,'cleanup_jobs').deleteOne({_id:job._id});completed++;
  }
  const now=db.now??new Date();
  const orphans=await collection(db,'assets').find({'payload.state':{$ne:'deleted'},upload_expires_at:{$lt:now},$or:[{attached_message_id:{$type:'string'},staging_deleted:{$ne:true}},{attached_message_id:null,created_at:{$lt:new Date(now.getTime()-86400000)}}]}).limit(batchSize).toArray();
  for(const a of orphans){
    try{
      const client=makeClient();await client.send(objectCommand(DeleteObjectCommand,a.upload_key));
      if(!a.attached_message_id)await client.send(objectCommand(DeleteObjectCommand,a.object_key));
    }catch{failed++;continue;}
    await collection(db,'assets').updateOne({_id:a.id},{$set:{staging_deleted:true,...(!a.attached_message_id?{'payload.state':'deleted'}:{})}});
  }
  // TTL indexes are a backstop. Explicit deletion keeps cursor metadata bounded.
  for(const name of ['query_snapshots','snapshot_items','rate_windows'])await collection(db,name).deleteMany({expires_at:{$lt:now}});
  return {completed,failed};
}
