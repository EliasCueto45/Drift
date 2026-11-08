import { readdir,readFile } from 'node:fs/promises';
import { transaction,closeDatabase,one } from '../apps/web/src/server/database.mjs';
import { saveCloud } from '../apps/web/src/server/records.mjs';
import { validate } from '../apps/web/src/server/validation.mjs';

// Seeds synthetic replay datasets only. Existing datasets are never reset.
try {
  for(const name of await readdir(new URL('../fixtures/scenarios/',import.meta.url))) {
    const base=new URL(`../fixtures/scenarios/${name}/`,import.meta.url);
    const scenario=JSON.parse(await readFile(new URL('scenario.json',base),'utf8'));
    const batch=validate('TrackingBatch',JSON.parse(await readFile(new URL(scenario.batches[0],base),'utf8')));
    if(!scenario.synthetic || !scenario.datasetId.startsWith('fx-')) throw new Error('Seed accepts synthetic fx-* datasets only');
    await transaction(async db=>{
      if(await one(db,'SELECT 1 FROM datasets WHERE id=$1',[batch.datasetId])) return;
      await db.query("INSERT INTO datasets(id,mode,run_id,sequence,observed_at) VALUES($1,'replay',$2,$3,$4)",[batch.datasetId,batch.trackingRunId,batch.sequence,batch.observedAt]);
      for(const user of scenario.seed.users) await db.query('INSERT INTO profiles(id,public_profile) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,user]);
      for(const cloud of batch.snapshots) {
        if(cloud.creatorId) await db.query('INSERT INTO profiles(id,public_profile) VALUES($1,$2) ON CONFLICT DO NOTHING',[cloud.creatorId,{id:cloud.creatorId,displayName:'Synthetic fixture creator',avatarUrl:null}]);
        await saveCloud(db,cloud);
      }
      for(const msg of scenario.seed.messages) {
        validate('Message',msg);
        await db.query(`INSERT INTO messages(id,cloud_id,author_id,payload,anchor,position_at) VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326),$7)`,[msg.id,msg.cloudId,msg.authorId,msg,msg.anchor.longitude,msg.anchor.latitude,msg.updatedAt]);
      }
      for(const event of batch.events) await db.query('INSERT INTO lifecycle_events(event_id,dataset_id,payload) VALUES($1,$2,$3)',[event.eventId,batch.datasetId,event]);
      await db.query('INSERT INTO tracking_batches(batch_id,dataset_id,sequence,acknowledgement) VALUES($1,$2,$3,$4)',[batch.batchId,batch.datasetId,batch.sequence,{sequence:batch.sequence}]);
      console.log(`Seeded synthetic replay: ${name}`);
    });
  }
} finally {await closeDatabase();}
