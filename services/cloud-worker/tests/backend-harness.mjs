// Explicit test process: real backend handlers/SQL with embedded PostGIS.
// Synthetic identity is injected through Owner 2's test seam, never production.
import { PGlite } from '../../../apps/web/src/server/node_modules/@electric-sql/pglite/dist/index.js';
import { postgis } from '../../../apps/web/src/server/node_modules/@electric-sql/pglite-postgis/dist/index.js';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { transaction } from '../../../apps/web/src/server/database.mjs';
import { createHandler } from '../../../apps/web/src/server/http.mjs';

const pg = new PGlite({extensions:{postgis}});
await pg.exec(await readFile(new URL('../../../db/migrations/001_backend.sql',import.meta.url),'utf8'));
await pg.query("INSERT INTO datasets(id,mode,run_id,observed_at) VALUES($1,$2,$3,'1970-01-01T00:00:00Z')",
  [process.env.TEST_DATASET??'backend-worker-demo',process.env.TEST_MODE??'replay',process.env.TEST_RUN??'run']);
const source = {connect:async()=>({query:(...args)=>pg.query(...args),release(){}})};
const handle = createHandler({run:fn=>transaction(fn,source),identity:async()=>({id:'worker-test-user',displayName:'Worker test',avatarUrl:null})});
const server=createServer(async(req,res)=>{
  try {
    const url=`http://127.0.0.1:${server.address().port}${req.url}`;
    const init={method:req.method,headers:req.headers};
    if(!['GET','HEAD'].includes(req.method)) {init.body=Readable.toWeb(req);init.duplex='half';}
    const result=await handle(new Request(url,init));
    res.writeHead(result.status,Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch(error) {console.error(error);res.writeHead(500);res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({base:`http://127.0.0.1:${server.address().port}`})));
