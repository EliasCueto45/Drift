import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collection } from '../database.mjs';
import { saveCloud,contains } from '../records.mjs';
import { openTestDatabase,get } from './helpers.mjs';
import { covers,validateGeometry,footprintDistanceM } from '../geometry.mjs';

test('MongoDB indexes and transactions enforce containment, uniqueness and rollback',async()=>{
  const harness=await openTestDatabase(),{run,context}=harness;
  try{
    const batch=JSON.parse(await readFile(new URL('../../../../../fixtures/scenarios/scattered-advection/batch-001.json',import.meta.url),'utf8')),cloud=batch.snapshots[0];
    await run(async db=>{
      await collection(db,'datasets').insertOne({_id:batch.datasetId,id:batch.datasetId,mode:'replay',run_id:batch.trackingRunId,sequence:0,observed_at:new Date(batch.observedAt),received_at:db.now});
      await saveCloud(db,cloud);
      const [longitude,latitude]=cloud.geometry.coordinates[0][0][0];await contains(db,cloud.id,{longitude,latitude});
    });
    await assert.rejects(run(async db=>{
      await collection(db,'profiles').insertOne({_id:'rolled-back',public_profile:{id:'rolled-back',displayName:null,avatarUrl:null}});
      await contains(db,cloud.id,{longitude:0,latitude:0});
    }),{status:422});
    assert.equal(await get(context,'profiles','rolled-back'),undefined);
    assert.equal(await collection(context,'cloud_history').countDocuments(),1);
    const indexes=await harness.source.db.collection('clouds').indexes();
    assert.ok(indexes.some(i=>i.key.footprint==='2dsphere'));
    await run(db=>collection(db,'votes').insertOne({_id:'vote-1',message_id:'m',user_id:'u'}));
    await assert.rejects(run(db=>collection(db,'votes').insertOne({_id:'vote-2',message_id:'m',user_id:'u'})),{code:11000});
  }finally{await harness.close();}
});
test('geographic holes and boundary inclusion remain distinct',()=>{
  const polygon={type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,2],[0,0]],[[0.5,0.5],[0.5,1.5],[1.5,1.5],[1.5,0.5],[0.5,0.5]]]};
  validateGeometry(polygon);
  assert.equal(covers(polygon,{longitude:0,latitude:1}),true);
  assert.equal(covers(polygon,{longitude:1,latitude:1}),false);
  assert.ok(footprintDistanceM(polygon,{longitude:1,latitude:1})>50000);
  assert.throws(()=>validateGeometry({type:'Polygon',coordinates:[[[0,0],[1,1],[0,1],[1,0],[0,0]]]}));
});
