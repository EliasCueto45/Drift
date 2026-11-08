import { createApiServer } from '../apps/web/src/server/serve.mjs';
import { closeDatabase } from '../apps/web/src/server/database.mjs';
import { validate,requireThat } from '../apps/web/src/server/validation.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

// Runs real anonymous/worker HTTP checks against the configured database.
// No synthetic authenticated identity and no message writes are used here.
await runCli(async()=>{
  const server=createApiServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const sky=await fetch(`${base}/api/v1/sky?lat=42.7284&lng=-73.6918&radiusM=50000&datasetId=fx-scattered`);
    requireThat(sky.status===200,'Anonymous sky read failed');
    const body=validate('SkyResponse',await sky.json());requireThat(body.data.clouds.length>0,'Run db/prepare.mjs first');
    const messages=await fetch(`${base}/api/v1/clouds/cld_scat_a/messages?scope=all`);
    requireThat(messages.status===200,'Message read failed');validate('MessagesResponse',await messages.json());
    const post=await fetch(`${base}/api/v1/clouds/cld_scat_a/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'text',body:'must not persist',anchor:{longitude:-73.7,latitude:42.7},expectedCloudVersion:1})});
    requireThat(post.status===401,'Anonymous write was not rejected');
    const denied=await fetch(`${base}/api/internal/tracking/state?datasetId=fx-scattered`,{headers:{authorization:'Bearer invalid-worker'}});
    requireThat(denied.status===401,'Invalid worker credential was not rejected');
    const state=await fetch(`${base}/api/internal/tracking/state?datasetId=fx-scattered`,{headers:{authorization:`Bearer ${process.env.TRACKING_INGEST_SECRET}`}});
    requireThat(state.status===200,'Authenticated worker state read failed');
    console.log(JSON.stringify({checksPassed:5,database:'configured MongoDB Atlas',identity:'real anonymous/worker boundaries',signedInClerkFlow:'not exercised',mediaService:'not exercised'}));
  }finally{await new Promise(resolve=>server.close(resolve));}
},closeDatabase);
