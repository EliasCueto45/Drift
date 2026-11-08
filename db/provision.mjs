import { transaction,collection,closeDatabase } from '../apps/web/src/server/database.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

const [id,mode,runId,start]=process.argv.slice(2);
await runCli(async()=>{
  if(!id||!['live','replay'].includes(mode)||!runId||!start?.endsWith('Z')||!Number.isFinite(Date.parse(start)))throw new Error('Usage: node db/provision.mjs DATASET_ID live|replay RUN_ID START_UTC');
  await transaction(db=>collection(db,'datasets').insertOne({_id:id,id,mode,run_id:runId,sequence:0,observed_at:new Date(start),received_at:db.now}));
  console.log('Provisioned dataset at sequence 0.');
},closeDatabase);
