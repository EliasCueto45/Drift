import { readdir,readFile } from 'node:fs/promises';
import { collection } from './database.mjs';
import { saveCloud } from './records.mjs';
import { pointGeometry } from './geometry.mjs';
import { validate } from './validation.mjs';
import { upsertProfile } from './auth.mjs';

export async function seedFixtures(run){
  let count=0;
  for(const name of await readdir(new URL('../../../../fixtures/scenarios/',import.meta.url))){
    const base=new URL(`../../../../fixtures/scenarios/${name}/`,import.meta.url);
    const meta=JSON.parse(await readFile(new URL('scenario.json',base),'utf8'));
    const batch=validate('TrackingBatch',JSON.parse(await readFile(new URL(meta.batches[0],base),'utf8')));
    if(!meta.synthetic||!meta.datasetId.startsWith('fx-'))throw new Error('Seed accepts synthetic fx-* datasets only');
    const inserted=await run(async db=>{
      if(await collection(db,'datasets').findOne({_id:batch.datasetId}))return false;
      await collection(db,'datasets').insertOne({_id:batch.datasetId,id:batch.datasetId,mode:'replay',run_id:batch.trackingRunId,sequence:batch.sequence,observed_at:new Date(batch.observedAt),received_at:db.now});
      for(const user of meta.seed.users)await upsertProfile(db,user);
      for(const cloud of batch.snapshots){
        if(cloud.creatorId)await upsertProfile(db,{id:cloud.creatorId,displayName:'Synthetic fixture creator',avatarUrl:null});
        await saveCloud(db,cloud);
      }
      for(const msg of meta.seed.messages){
        validate('Message',msg);
        await collection(db,'messages').insertOne({_id:msg.id,id:msg.id,cloud_id:msg.cloudId,author_id:msg.authorId,asset_id:msg.assetId,payload:msg,anchor:pointGeometry(msg.anchor),position_at:new Date(msg.updatedAt),expired_at:null,held:false,strokes:null});
      }
      for(const event of batch.events)await collection(db,'lifecycle_events').insertOne({_id:event.eventId,dataset_id:batch.datasetId,payload:event});
      await collection(db,'tracking_batches').insertOne({_id:batch.batchId,dataset_id:batch.datasetId,sequence:batch.sequence,acknowledgement:{sequence:batch.sequence}});
      return true;
    });
    if(inserted)count++;
  }
  return count;
}
