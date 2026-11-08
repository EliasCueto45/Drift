import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { validate } from "../validation.mjs";
import { inspectMedia,uploadInput } from "../storage.mjs";
import { workerAuth } from "../auth.mjs";
import { requestIdentity } from "../auth.mjs";
import { createHandler,readJson } from "../http.mjs";
const text={"kind":"text","body":"hello","anchor":{"longitude":-73.7,"latitude":42.7},"expectedCloudVersion":1};
test('standalone auth allows anonymous reads and rejects missing, forged and worker identities',async()=>{
  assert.equal(await requestIdentity(false,new Request('http://localhost:3000/api/v1/sky')),null);
  await assert.rejects(requestIdentity(true,new Request('http://localhost:3000/api/v1/clouds')),{status:401});
  await assert.rejects(requestIdentity(true,new Request('http://localhost:3000/api/v1/clouds',{headers:{authorization:'Bearer worker-secret'}})),{status:401});
  const previous=process.env.CLERK_SECRET_KEY;delete process.env.CLERK_SECRET_KEY;
  try{await assert.rejects(requestIdentity(true,new Request('http://localhost:3000/api/v1/clouds',{headers:{authorization:'Bearer fake.jwt.signature'}})),{status:503});}
  finally{if(previous!==undefined)process.env.CLERK_SECRET_KEY=previous;}
});
test('real PNG decoding strips metadata and rejects forged or oversized media',async()=>{
  const bytes=await sharp({create:{width:4,height:4,channels:4,background:{r:10,g:20,b:30,alpha:0.5}}}).withMetadata({exif:{IFD0:{Artist:'private metadata'}}}).png().toBuffer();
  const result=await inspectMedia(bytes,{kind:'png',mimeType:'image/png'});
  assert.equal(result.metadata.width,4);
  const meta=await sharp(result.bytes).metadata(); assert.equal(meta.exif,undefined);assert.equal(meta.hasAlpha,true);
  await assert.rejects(inspectMedia(Buffer.from('not png'),{kind:'png'}));
  const large=await sharp({create:{width:4097,height:1,channels:4,background:'transparent'}}).png().toBuffer();
  await assert.rejects(inspectMedia(large,{kind:'drawing'}));
  assert.throws(()=>uploadInput({kind:'png',mimeType:'image/png',sizeBytes:6*1024*1024}),{status:413});
  await assert.rejects(inspectMedia(Buffer.from('garbage audio'),{kind:'audio',mimeType:'audio/mpeg'}));
});
test('audio duration is decoded from actual WAV samples',async()=>{
  function wav(seconds){const n=8000*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b;}
  assert.equal((await inspectMedia(wav(1),{kind:'audio',mimeType:'audio/wav'})).metadata.durationSec,1);
  await assert.rejects(inspectMedia(wav(61),{kind:'audio',mimeType:'audio/wav'}));
});
test('worker credentials and browser writes cannot use each other',async()=>{
  const old=process.env.TRACKING_INGEST_SECRET;process.env.TRACKING_INGEST_SECRET='test-worker-secret';
  try {
    assert.throws(()=>workerAuth(new Request('http://localhost/api/internal/tracking/state')),{status:401});
    const handler=createHandler({identity:async()=>null,run:()=>{throw new Error('Database must not be reached');}});
    const req=new Request('http://localhost/api/v1/clouds/x/messages',{method:'POST',headers:{authorization:'Bearer test-worker-secret','content-type':'application/json'},body:JSON.stringify(text)});
    const response=await handler(req);assert.equal(response.status,401);validate('ApiError',await response.json());
    assert.equal((await handler(new Request('http://localhost/api/internal/tracking/state'))).status,401);
  } finally {if(old===undefined) delete process.env.TRACKING_INGEST_SECRET;else process.env.TRACKING_INGEST_SECRET=old;}
});
test('HTTP errors are bounded, structured and do not expose internal errors',async()=>{
  await assert.rejects(readJson(new Request('http://localhost',{method:'POST',headers:{'content-type':'application/json'},body:'{bad'})),{status:422});
  await assert.rejects(readJson(new Request('http://localhost',{method:'POST',headers:{'content-type':'application/json'},body:'"too long"'}),2),{status:413});
  const handler=createHandler({identity:async()=>({id:'user'}),run:()=>{throw new Error('secret body');}});
  const denied=await handler(new Request('http://localhost/api/v1/clouds',{method:'POST',headers:{origin:'https://evil.test','content-type':'application/json'},body:'{}'}));assert.equal(denied.status,403);
  const result=await handler(new Request('http://localhost/api/v1/sky?lat=1&lng=1&datasetId=x'));assert.equal(result.status,500);assert.ok(!(await result.text()).includes('secret body'));
});
