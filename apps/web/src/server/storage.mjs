import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { parseBuffer } from 'music-metadata';
import { one } from './database.mjs';
import { cloudRecord, messageRecord, publicMessage } from './records.mjs';
import { exact, fail, requireThat } from './validation.mjs';
import { rateLimit } from './auth.mjs';

const mimeTypes = {png:['image/png'],drawing:['image/png'],audio:['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4']};
export function assetLimit(kind) { return kind === 'audio' ? 10*1024*1024 : 5*1024*1024; }
export function uploadInput(input) {
  exact(input,['kind','mimeType','sizeBytes']);
  requireThat(mimeTypes[input.kind]?.includes(input.mimeType),'Unsupported media type');
  requireThat(Number.isInteger(input.sizeBytes) && input.sizeBytes > 0,'sizeBytes must be positive integer');
  if (input.sizeBytes > assetLimit(input.kind)) fail(413,'TOO_LARGE','Media exceeds byte limit');
}
export function storageClient() {
  for (const key of ['S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY']) if (!process.env[key]) fail(503,'NOT_CONFIGURED','Storage is not configured');
  return new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT || undefined,forcePathStyle:!!process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}});
}
export function objectCommand(Command,key,extra={}) { return new Command({Bucket:process.env.S3_BUCKET,Key:key,...extra}); }
export async function readObject(client,key,max) {
  const object = await client.send(objectCommand(GetObjectCommand,key));
  if (object.ContentLength > max) { object.Body.destroy(); fail(413,'TOO_LARGE','Stored object exceeds byte limit'); }
  let size = 0; const chunks = [];
  for await (const chunk of object.Body) {
    size += chunk.length;
    if (size > max) { object.Body.destroy(); fail(413,'TOO_LARGE','Stored object exceeds byte limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function inspectMedia(bytes,asset) {
  if (asset.kind !== 'audio') {
    requireThat(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'PNG signature required');
    const image = sharp(bytes,{limitInputPixels:4096*4096,animated:false,failOn:'warning'});
    let metadata,clean;
    try {
      metadata = await image.metadata();
      requireThat(metadata.format==='png' && (metadata.pages??1)===1 && metadata.width<=4096 && metadata.height<=4096,'Single PNG up to 4096 pixels per side required');
      clean = await image.png().toBuffer();
    } catch (e) { if(e.status) throw e; fail(422,'INVALID_MEDIA','PNG could not be decoded'); }
    requireThat(clean.length<=assetLimit(asset.kind),'Re-encoded PNG exceeds size limit');
    return {bytes:clean,metadata:{width:metadata.width,height:metadata.height,durationSec:null}};
  }
  const magic = {
    'audio/wav': b=>b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WAVE',
    'audio/ogg': b=>b.toString('ascii',0,4)==='OggS',
    'audio/webm': b=>b.subarray(0,4).equals(Buffer.from([26,69,223,163])),
    'audio/mp4': b=>b.toString('ascii',4,8)==='ftyp',
    'audio/mpeg': b=>b.toString('ascii',0,3)==='ID3' || (b[0]===255 && (b[1]&224)===224),
  };
  requireThat(magic[asset.mimeType]?.(bytes),'Audio signature does not match declared type');
  let parsed;
  try { parsed = await parseBuffer(bytes,{mimeType:asset.mimeType,size:bytes.length},{duration:true}); }
  catch { fail(422,'INVALID_MEDIA','Audio could not be decoded'); }
  const duration = parsed.format.duration;
  requireThat(Number.isFinite(duration) && duration>0 && duration<=60 && parsed.format.codec,'Audio duration must be known and at most 60 seconds');
  return {bytes,metadata:{width:null,height:null,durationSec:duration}};
}
export async function uploadUrl(db,input,user,client=storageClient()) {
  uploadInput(input); await rateLimit(db,user.id,'upload',10);
  const id=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+300000).toISOString();
  const asset={id,ownerId:user.id,...input,state:'pending',createdAt};
  const uploadKey=`pending/${id}/${randomUUID()}`, objectKey=`ready/${id}/${randomUUID()}`;
  const url=await getSignedUrl(client,objectCommand(PutObjectCommand,uploadKey,{ContentType:input.mimeType,ContentLength:input.sizeBytes}),{expiresIn:300});
  await db.query('INSERT INTO assets(id,owner_id,payload,upload_key,object_key,upload_expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,user.id,asset,uploadKey,objectKey,expiresAt]);
  return {data:{assetId:id,uploadUrl:url,expiresAt}};
}
export async function completeAsset(db,id,user,client=storageClient()) {
  const row=await one(db,'SELECT * FROM assets WHERE id=$1',[id]);
  if(!row) fail(404,'NOT_FOUND','Asset not found');
  requireThat(row.owner_id===user.id,'Asset owner only','FORBIDDEN',403);
  if(row.payload.state==='ready') return {data:row.payload};
  requireThat(row.payload.state==='pending' && row.upload_expires_at.getTime()>Date.now(),'Upload expired','UPLOAD_EXPIRED',410);
  const bytes=await readObject(client,row.upload_key,assetLimit(row.payload.kind));
  requireThat(bytes.length===row.payload.sizeBytes,'Uploaded size differs from declaration');
  const inspected=await inspectMedia(bytes,row.payload);
  // A separate immutable ready key prevents a still-valid PUT URL from replacing
  // verified bytes after completion. No ready key is exposed to the browser.
  await client.send(objectCommand(PutObjectCommand,row.object_key,{Body:inspected.bytes,ContentType:row.payload.mimeType,CacheControl:'private, no-store'}));
  const payload={...row.payload,...inspected.metadata,sizeBytes:inspected.bytes.length,state:'ready'};
  await db.query('UPDATE assets SET payload=$2 WHERE id=$1',[id,payload]);
  return {data:payload};
}
export async function playbackUrl(db,id,viewer,client=storageClient()) {
  const row=await one(db,'SELECT * FROM assets WHERE id=$1',[id]);
  if(!row) fail(404,'NOT_FOUND','Asset not found');
  requireThat(row.payload.state==='ready' && row.attached_message_id,'Asset unavailable','CLOUD_EXPIRED',410);
  const msg=await messageRecord(db,row.attached_message_id);
  if(!await publicMessage(db,msg,viewer?.id)) fail(410,'CLOUD_EXPIRED','Content expired');
  const c=await cloudRecord(db,msg.cloud_id);
  let ttl=60;
  if(c.payload.expiresAt) ttl=Math.min(ttl,Math.floor((Date.parse(c.payload.expiresAt)-c.ds.clock.getTime())/1000));
  requireThat(ttl>0,'Content expired','CLOUD_EXPIRED',410);
  const url=await getSignedUrl(client,objectCommand(GetObjectCommand,row.object_key,{ResponseCacheControl:'private, no-store',ResponseContentType:row.payload.mimeType}),{expiresIn:ttl});
  return {data:{url,expiresAt:new Date(Date.now()+ttl*1000).toISOString()}};
}
export async function artwork(db,id,viewer) {
  const m=await messageRecord(db,id);
  if(!await publicMessage(db,m,viewer?.id)) fail(410,'CLOUD_EXPIRED','Content expired');
  requireThat(m.payload.kind==='drawing','Message is not a drawing');
  return {data:{strokes:m.strokes,artworkTransform:m.payload.artworkTransform}};
}
export { DeleteObjectCommand };
