// Disposable integration process for the Python worker tests. Synthetic identity
// is confined to this test entry point; serve.mjs always uses verified Clerk.
import { openTestDatabase } from './helpers.mjs';
import { collection } from '../database.mjs';
import { createHandler } from '../http.mjs';
import { createApiServer } from '../serve.mjs';

// The Python client expects the first stdout line to be the ready JSON.
// Send first-run binary download progress to stderr during initialization.
const log=console.log;console.log=(...args)=>console.error(...args);
let harness;
try{harness=await openTestDatabase();}finally{console.log=log;}
const id=process.env.TEST_DATASET??'backend-worker-demo';
const mode=process.env.TEST_MODE??'replay',runId=process.env.TEST_RUN??'run';
if(!['live','replay'].includes(mode))throw new Error('Invalid test mode');
await harness.run(db=>collection(db,'datasets').insertOne({_id:id,id,mode,run_id:runId,sequence:0,observed_at:new Date(0),received_at:db.now}));
const handle=createHandler({run:harness.run,identity:async()=>({id:'worker-test-user',displayName:'Synthetic worker test',avatarUrl:null})});
const server=createApiServer({handle});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({base:`http://127.0.0.1:${server.address().port}`})));
const stop=()=>server.close(async()=>{await harness.close();process.exit();});
process.once('SIGINT',stop);process.once('SIGTERM',stop);
process.on('message',message=>{if(message==='stop')stop();});
