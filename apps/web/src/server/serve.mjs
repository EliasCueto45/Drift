import './environment.mjs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createHandler } from './http.mjs';
import { requestIdentity } from './auth.mjs';
import { closeDatabase } from './database.mjs';
import { randomUUID } from 'node:crypto';

export function createApiServer({handle=createHandler({identity:requestIdentity}),origin}={}){
  const server=createServer(async(req,res)=>{
    try{
      const base=origin??`http://127.0.0.1:${server.address().port}`;
      const url=new URL(req.url,base);
      if(url.origin!==new URL(base).origin){res.writeHead(400);res.end();return;}
      const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
      const response=await handle(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{
      res.writeHead(500,{'content-type':'application/json','cache-control':'private, no-store'});
      res.end(JSON.stringify({error:{code:'INTERNAL',message:'Request could not be completed',requestId:randomUUID()}}));
    }
  });
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1..65535');
  const server=createApiServer({origin:process.env.DRIFT_API_ORIGIN||`http://localhost:${port}`});
  server.requestTimeout=30000;server.headersTimeout=15000;
  server.on('error',()=>{console.error('API listener could not start; check the configured port.');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Drift API listening at http://localhost:${port}; authentication uses real Clerk sessions.`));
  const stop=()=>server.close(async()=>{await closeDatabase();process.exit();});
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
