import { transaction,collection,closeDatabase } from '../apps/web/src/server/database.mjs';
import { seedFixtures } from '../apps/web/src/server/fixtures.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

await runCli(async()=>{
  const count=await seedFixtures(transaction);
  console.log(`Initialized ${count} synthetic fixture datasets; existing data was left intact.`);
  const id=process.env.DRIFT_DATASET_ID||'troy-demo';
  // Creation of live datasets remains explicit: an ID alone cannot change mode.
  if(!id.endsWith('-demo')){console.log('Live dataset was not auto-provisioned; use db/provision.mjs with an explicit mode/run.');return;}
  const created=await transaction(async db=>{
    if(await collection(db,'datasets').findOne({_id:id}))return false;
    await collection(db,'datasets').insertOne({_id:id,id,mode:'replay',run_id:'regional-v1',sequence:0,observed_at:new Date(0),received_at:db.now});return true;
  });
  console.log(created?'Provisioned isolated replay dataset at sequence 0.':'Configured replay dataset already exists; sequence preserved.');
},closeDatabase);
