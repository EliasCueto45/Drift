import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDatabaseSource,transaction,collection } from '../database.mjs';

export async function openTestDatabase(){
  const repl=await MongoMemoryReplSet.create({binary:{downloadDir:fileURLToPath(new URL('../node_modules/.cache/mongodb-binaries/',import.meta.url))},replSet:{count:1,storageEngine:'wiredTiger'}});
  const name='drift_test_'+randomUUID().replaceAll('-',''),client=new MongoClient(repl.getUri());
  await client.connect();const source=createDatabaseSource(client,name);await source.ready;
  return {source,context:{db:source.db},run:fn=>transaction(fn,source),close:async()=>{await client.close();await repl.stop();}};
}
export async function get(context,name,id){return await collection(context,name).findOne({_id:id})??undefined;}
