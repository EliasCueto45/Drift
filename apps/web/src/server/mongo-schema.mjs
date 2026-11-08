const names=['profiles','datasets','clouds','cloud_history','assets','messages','votes','tracking_batches','lifecycle_events','cleanup_jobs','rate_windows','query_snapshots','snapshot_items','schema_migrations','transaction_guards'];

export async function initializeDatabase(source) {
  const db=source.db;
  for(const name of names) {
    try {await db.createCollection(name,{validator:{$jsonSchema:{bsonType:'object',required:['_id'],properties:{_id:{bsonType:'string'}}}}});}
    catch(error){if(error.code!==48)throw error;}
  }
  const index=async(name,keys,options={})=>db.collection(name).createIndex(keys,options);
  await index('clouds',{dataset_id:1});
  await index('clouds',{footprint:'2dsphere'});
  await index('clouds',{'payload.parentIds':1});
  await index('messages',{anchor:'2dsphere'});
  await index('messages',{cloud_id:1,expired_at:1,held:1});
  await index('messages',{asset_id:1},{unique:true,partialFilterExpression:{asset_id:{$type:'string'}}});
  await index('cloud_history',{cloud_id:1,version:1},{unique:true});
  await index('assets',{upload_key:1},{unique:true});
  await index('assets',{object_key:1},{unique:true});
  await index('assets',{attached_message_id:1},{unique:true,partialFilterExpression:{attached_message_id:{$type:'string'}}});
  await index('votes',{message_id:1,user_id:1},{unique:true});
  await index('tracking_batches',{dataset_id:1,sequence:1},{unique:true});
  await index('lifecycle_events',{dataset_id:1});
  await index('cleanup_jobs',{queued_at:1});
  await index('snapshot_items',{snapshot_id:1,ordinal:1},{unique:true});
  for(const name of ['query_snapshots','snapshot_items','rate_windows']) await index(name,{expires_at:1},{expireAfterSeconds:0});
  await db.collection('transaction_guards').updateOne({_id:'backend'},{$setOnInsert:{revision:0}},{upsert:true});
  await db.collection('schema_migrations').updateOne({_id:'002_mongodb' },{$setOnInsert:{applied_at:new Date(),version:2}},{upsert:true});
}
