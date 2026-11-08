import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { clerkIdentity,workerAuth,checkOrigin,upsertProfile } from './auth.mjs';
import { ApiError,fail,requireThat } from './validation.mjs';
import { sky,cloudDetail,messagePage } from './discovery.mjs';
import { createCloud,deleteCloud,createMessage,deleteMessage,upvote } from './mutations.mjs';
import { ingest,trackingState } from './tracking.mjs';
import { uploadUrl,completeAsset,playbackUrl,artwork } from './storage.mjs';

export async function readJson(request,max=2*1024*1024) {
  requireThat(request.headers.get('content-type')?.split(';')[0].trim()==='application/json','application/json required');
  if(Number(request.headers.get('content-length'))>max) fail(413,'TOO_LARGE','Request exceeds size limit');
  const reader=request.body?.getReader(); if(!reader) fail(422,'INVALID','JSON body required');
  let size=0; const chunks=[];
  while(true) {
    const {done,value}=await reader.read(); if(done) break;
    size+=value.length; if(size>max) {await reader.cancel();fail(413,'TOO_LARGE','Request exceeds size limit');} chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(422,'INVALID','Malformed JSON'); }
}
const json=(body,status,requestId)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','x-request-id':requestId,'x-content-type-options':'nosniff'}});

// Test seams inject verified identities/transactions explicitly. Production only
// exports the instance using Clerk; there is no environment auth bypass.
export function createHandler({identity=clerkIdentity,run=transaction,worker=workerAuth}={}) {
  return async function handle(request) {
    const requestId=randomUUID();
    try {
      const url=new URL(request.url), path=url.pathname,method=request.method;
      let m,fn,status=200;
      if(path.startsWith('/api/internal/')) {
        worker(request);
        if(path==='/api/internal/tracking/batches' && method==='POST') { const body=await readJson(request,10*1024*1024); fn=db=>ingest(db,body); }
        else if(path==='/api/internal/tracking/state' && method==='GET') fn=db=>trackingState(db,url.searchParams);
        else fail(404,'NOT_FOUND','Route not found');
      } else {
        const writes=['POST','PUT','DELETE'].includes(method);
        if(writes) checkOrigin(request);
        const user=await identity(writes,request);
        if(writes && !user) fail(401,'UNAUTHENTICATED','Sign in required');
        if(path==='/api/v1/sky' && method==='GET') fn=db=>sky(db,url.searchParams,user);
        else if(path==='/api/v1/clouds' && method==='POST') {const body=await readJson(request); fn=db=>createCloud(db,body,user);status=201;}
        else if((m=path.match(/^\/api\/v1\/clouds\/([^/]+)\/messages$/))) {
          const id=decodeURIComponent(m[1]);
          if(method==='GET') fn=db=>messagePage(db,id,url.searchParams,user);
          else if(method==='POST') {const body=await readJson(request);fn=db=>createMessage(db,id,body,user);status=201;}
        } else if((m=path.match(/^\/api\/v1\/clouds\/([^/]+)$/))) {
          const id=decodeURIComponent(m[1]);
          if(method==='GET') fn=db=>cloudDetail(db,id);
          else if(method==='DELETE') fn=db=>deleteCloud(db,id,user);
        } else if((m=path.match(/^\/api\/v1\/messages\/([^/]+)\/upvote$/)) && method==='PUT') {
          const id=decodeURIComponent(m[1]),body=await readJson(request);fn=db=>upvote(db,id,body,user);
        } else if((m=path.match(/^\/api\/v1\/messages\/([^/]+)$/)) && method==='DELETE') {
          const id=decodeURIComponent(m[1]);fn=db=>deleteMessage(db,id,user);
        } else if(path==='/api/v1/assets/upload-url' && method==='POST') {
          const body=await readJson(request);fn=db=>uploadUrl(db,body,user);
        } else if((m=path.match(/^\/api\/v1\/assets\/([^/]+)\/complete$/)) && method==='POST') {
          const id=decodeURIComponent(m[1]);fn=db=>completeAsset(db,id,user);
        } else if((m=path.match(/^\/api\/v1\/assets\/([^/]+)\/url$/)) && method==='GET') {
          const id=decodeURIComponent(m[1]);fn=db=>playbackUrl(db,id,user);
        } else if((m=path.match(/^\/api\/v1\/messages\/([^/]+)\/artwork$/)) && method==='GET') {
          const id=decodeURIComponent(m[1]);fn=db=>artwork(db,id,user);
        }
        if(fn) {const execute=fn;fn=async db=>{await upsertProfile(db,user);return execute(db);};}
      }
      if(!fn) fail(404,'NOT_FOUND','Route not found');
      const result=await run(fn);
      return json(result,status,requestId);
    } catch(error) {
      if(error instanceof ApiError) return json({error:{code:error.code,message:error.message,requestId}},error.status,requestId);
      // Preserve privacy even when DB/media errors contain submitted payloads.
      console.error('Drift API failure',{requestId,category:error?.name??'Error'});
      return json({error:{code:'INTERNAL',message:'Request could not be completed',requestId}},500,requestId);
    }
  };
}
export const handle=createHandler();
