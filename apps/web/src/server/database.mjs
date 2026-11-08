import './environment.mjs';
import { MongoClient } from 'mongodb';
import { fail } from './validation.mjs';
import { initializeDatabase } from './mongo-schema.mjs';
export { initializeDatabase };

let shared;
export function collection(context,name) {
  const c=context.db.collection(name),opts=o=>({...o,...(context.session?{session:context.session}:{})});
  return {
    find:(f={},o={})=>c.find(f,opts(o)),findOne:(f,o={})=>c.findOne(f,opts(o)),
    insertOne:(v,o={})=>c.insertOne(v,opts(o)),insertMany:(v,o={})=>c.insertMany(v,opts(o)),
    updateOne:(f,u,o={})=>c.updateOne(f,u,opts(o)),updateMany:(f,u,o={})=>c.updateMany(f,u,opts(o)),
    replaceOne:(f,v,o={})=>c.replaceOne(f,v,opts(o)),deleteOne:(f,o={})=>c.deleteOne(f,opts(o)),
    deleteMany:(f,o={})=>c.deleteMany(f,opts(o)),countDocuments:(f={},o={})=>c.countDocuments(f,opts(o)),
    aggregate:(p,o={})=>c.aggregate(p,opts(o)),
  };
}
export function createDatabaseSource(client,databaseName) {
  const source={client,db:client.db(databaseName)};
  source.ready=initializeDatabase(source);return source;
}
export async function database() {
  if(!process.env.MONGODB_URI) fail(503,'NOT_CONFIGURED','MONGODB_URI is required');
  if(!shared) shared=(async()=>{
    let client;
    try {
      client=new MongoClient(process.env.MONGODB_URI,{maxPoolSize:10,serverSelectionTimeoutMS:10000});
      await client.connect();
      const source=createDatabaseSource(client,process.env.MONGODB_DB||'drift');
      await source.ready;return source;
    } catch(error) {if(client)await client.close();shared=undefined;fail(503,'DATABASE_UNAVAILABLE',error.code===18?'MongoDB authentication failed':'MongoDB is unavailable; check credentials and Atlas network access');}
  })();
  return shared;
}
export async function transaction(fn,provided) {
  const source=provided??await database();await source.ready;
  const session=source.client.startSession();
  try {
    return await session.withTransaction(async()=>{
      // Every operation touches the same guard first. Conflicting sessions retry
      // their entire snapshot, preventing post/retirement and vote/cleanup skew.
      await source.db.collection('transaction_guards').updateOne({_id:'backend'},{$inc:{revision:1}},{session});
      return fn({db:source.db,session,now:new Date()});
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:10000});
  } finally {await session.endSession();}
}
export async function closeDatabase(){if(shared){const source=await shared;shared=undefined;await source.client.close();}}
export async function datasetTime(context,id){
  const row=await collection(context,'datasets').findOne({_id:id});
  return row?{...row,clock:row.mode==='replay'?row.observed_at:context.now??new Date()}:null;
}
