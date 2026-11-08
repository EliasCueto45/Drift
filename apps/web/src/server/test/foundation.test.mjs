import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
import { transaction,one } from '../database.mjs';
import { saveCloud,contains } from '../records.mjs';

test('foundation migration enforces spatial containment and rolls back failed operations',async()=>{
  const pg=new PGlite({extensions:{postgis}});
  const source={connect:async()=>({query:(...args)=>pg.query(...args),release(){}})};
  const run=fn=>transaction(fn,source);
  try {
    await pg.exec(await readFile(new URL('../../../../../db/migrations/001_backend.sql',import.meta.url),'utf8'));
    const batch=JSON.parse(await readFile(new URL('../../../../../fixtures/scenarios/scattered-advection/batch-001.json',import.meta.url),'utf8'));
    const cloud=batch.snapshots[0];
    await run(async db=>{
      await db.query("INSERT INTO datasets(id,mode,run_id,observed_at) VALUES($1,'replay',$2,$3)",[batch.datasetId,batch.trackingRunId,batch.observedAt]);
      await saveCloud(db,cloud);
      const [longitude,latitude]=cloud.geometry.coordinates[0][0][0];
      await contains(db,cloud.id,{longitude,latitude});
    });
    await assert.rejects(run(async db=>{
      await db.query('INSERT INTO profiles(id,public_profile) VALUES($1,$2)',['rolled-back',{id:'rolled-back',displayName:null,avatarUrl:null}]);
      await contains(db,cloud.id,{longitude:0,latitude:0});
    }),{status:422});
    assert.equal(await one(pg,"SELECT 1 FROM profiles WHERE id='rolled-back'"),undefined);
    assert.equal((await one(pg,'SELECT count(*)::int n FROM cloud_history')).n,1);
    assert.ok((await one(pg,"SELECT indexname FROM pg_indexes WHERE indexname='clouds_footprint_gist'")).indexname);
  } finally {await pg.close();}
});
