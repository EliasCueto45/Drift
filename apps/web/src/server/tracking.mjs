import { collection,datasetTime } from './database.mjs';
import { contains,expireMessage,geometryValid,saveCloud } from './records.mjs';
import { pointGeometry } from './geometry.mjs';
import { fail,limit,requireThat,utc,validate } from './validation.mjs';
import { snapshotPage } from './pagination.mjs';

function unique(items,key){requireThat(new Set(items.map(x=>x[key])).size===items.length,`Duplicate ${key}`);}
export async function ingest(db,batch){
  validate('TrackingBatch',batch);utc(batch.observedAt);
  unique(batch.snapshots,'id');unique(batch.events,'eventId');unique(batch.anchorUpdates,'messageId');
  const clouds=collection(db,'clouds'),messages=collection(db,'messages'),batches=collection(db,'tracking_batches');
  const old=await batches.findOne({_id:batch.batchId});
  if(old){requireThat(old.dataset_id===batch.datasetId,'Batch ID belongs to another dataset','BATCH_CONFLICT',409);return {data:old.acknowledgement};}
  const ds=await datasetTime(db,batch.datasetId);
  if(!ds)fail(409,'DATASET_NOT_READY','Provision dataset/run before ingest');
  requireThat(ds.run_id===batch.trackingRunId,'Tracking run mismatch','RUN_CONFLICT',409);
  requireThat(batch.sequence===ds.sequence+1,`Expected sequence ${ds.sequence+1}`,'OUT_OF_ORDER',409);
  requireThat(Date.parse(batch.observedAt)>=ds.observed_at.getTime(),'Observation clock moved backwards','OUT_OF_ORDER',409);
  const existing=new Map();
  for(const cloud of batch.snapshots){
    validate('Cloud',cloud);utc(cloud.updatedAt);utc(cloud.observedAt);utc(cloud.wind.validAt);
    requireThat(cloud.datasetId===batch.datasetId&&cloud.trackingRunId===batch.trackingRunId,'Snapshot dataset/run mismatch');
    const prev=await clouds.findOne({_id:cloud.id});existing.set(cloud.id,prev);
    requireThat(!prev||prev.dataset_id===batch.datasetId,'Cross-dataset cloud','DATASET_CONFLICT',409);
    requireThat(cloud.version===(prev?prev.payload.version+1:1),'Cloud version conflict','VERSION_CONFLICT',409);
    if(prev){
      requireThat((!prev.deleted_at||cloud.status==='expired')&&!(prev.payload.status==='expired'&&cloud.status!=='expired'),'Cloud cannot be resurrected','VERSION_CONFLICT',409);
      requireThat(cloud.kind===prev.payload.kind&&cloud.creatorId===prev.payload.creatorId&&cloud.expiresAt===prev.payload.expiresAt,'Immutable cloud fields changed');
    }else requireThat(cloud.kind==='observed'&&cloud.creatorId===null&&cloud.expiresAt===null,'Worker cannot create user clouds');
    requireThat(Date.parse(cloud.updatedAt)<=Date.parse(batch.observedAt)&&Date.parse(cloud.observedAt)<=Date.parse(batch.observedAt),'Snapshot time exceeds batch');
    await geometryValid(db,cloud.geometry);await saveCloud(db,cloud);
  }
  for(const cloud of batch.snapshots){
    for(const parentId of cloud.parentIds){
      const parent=await clouds.findOne({_id:parentId});
      requireThat(parent&&parent.id!==cloud.id&&parent.dataset_id===batch.datasetId&&parent.payload.kind==='observed'&&cloud.kind==='observed','Invalid lineage parent');
    }
    const pending=[...cloud.parentIds],seen=new Set();
    while(pending.length){
      const id=pending.pop();requireThat(id!==cloud.id,'Cyclic cloud lineage');
      if(seen.has(id))continue;seen.add(id);
      const row=await clouds.findOne({_id:id});if(row)pending.push(...row.payload.parentIds);
    }
  }
  for(const event of batch.events){
    utc(event.effectiveAt);requireThat(Date.parse(event.effectiveAt)<=Date.parse(batch.observedAt),'Event time exceeds batch');
    for(const id of [...event.sourceCloudIds,...event.targetCloudIds]){
      const row=await clouds.findOne({_id:id});
      requireThat(row&&row.dataset_id===batch.datasetId,'Event references foreign or unknown cloud');
      if(['merged','split'].includes(event.type))requireThat(row.payload.kind==='observed','Created clouds cannot merge/split');
    }
    if(['merged','split'].includes(event.type)){
      requireThat(event.sourceCloudIds.length>0&&event.targetCloudIds.length>0,'Lineage requires sources and targets');
      for(const id of event.sourceCloudIds)requireThat((await clouds.findOne({_id:id})).payload.status==='expired','Lineage predecessors must retire');
    }
    requireThat(!await collection(db,'lifecycle_events').findOne({_id:event.eventId}),'Event ID already used','EVENT_CONFLICT',409);
    await collection(db,'lifecycle_events').insertOne({_id:event.eventId,dataset_id:batch.datasetId,payload:event});
  }
  for(const u of batch.anchorUpdates){
    const row=await messages.findOne({_id:u.messageId});
    const currentOrigin=row?await clouds.findOne({_id:row.cloud_id}):null;
    requireThat(row&&currentOrigin?.dataset_id===batch.datasetId&&!row.expired_at&&row.payload.version===u.expectedMessageVersion,'Message version conflict','VERSION_CONFLICT',409);
    const oldOrigin=existing.get(row.cloud_id)?.payload??currentOrigin.payload;
    const end=oldOrigin.kind==='created'?Date.parse(currentOrigin.payload.updatedAt):Math.min(Date.parse(batch.observedAt),Date.parse(oldOrigin.observedAt)+1800000);
    const positionAt=new Date(Math.max(row.position_at.getTime(),end));
    let target=row.cloud_id;
    if(u.targetCloudId!==null){
      const c=await clouds.findOne({_id:u.targetCloudId});
      requireThat(c&&c.dataset_id===batch.datasetId,'Invalid transfer target');
      requireThat(c.payload.kind===currentOrigin.payload.kind,'Cannot transfer between created/observed clouds');
      if(c.payload.kind==='created')requireThat(c.id===row.cloud_id,'Created clouds are independent');
      if(u.action==='move'){
        requireThat(c.payload.status!=='expired','Cannot move into retired cloud');
        await contains(db,c.id,u.anchor);target=c.id;
      }
    }
    if(row.payload.artworkTransform&&u.action!=='expire')requireThat(u.artworkControlPoints?.length===row.payload.artworkTransform.controlPoints?.length,'Artwork transport requires all control points');
    const payload={...row.payload,cloudId:target,anchor:u.anchor,version:row.payload.version+1,updatedAt:batch.observedAt};
    if(u.artworkControlPoints){requireThat(payload.artworkTransform,'Control points require artwork');payload.artworkTransform={...payload.artworkTransform,controlPoints:u.artworkControlPoints};}
    if(u.action==='expire')payload.expiredAt=batch.observedAt;
    await messages.updateOne({_id:row.id},{$set:{cloud_id:target,payload,anchor:pointGeometry(u.anchor),held:u.action==='hold',position_at:positionAt,expired_at:payload.expiredAt?new Date(payload.expiredAt):null}});
    if(u.action==='expire')await expireMessage(db,row.id,batch.observedAt);
  }
  for(const cloud of batch.snapshots.filter(c=>c.status==='expired')){
    requireThat(!await messages.findOne({cloud_id:cloud.id,expired_at:null,held:false}),'Retired cloud still has unresolved messages','VERSION_CONFLICT',409);
  }
  await collection(db,'datasets').updateOne({_id:batch.datasetId},{$set:{sequence:batch.sequence,observed_at:new Date(batch.observedAt),received_at:db.now??new Date()}});
  const ack={sequence:batch.sequence};
  await batches.insertOne({_id:batch.batchId,dataset_id:batch.datasetId,sequence:batch.sequence,acknowledgement:ack});
  return {data:ack};
}
export async function trackingState(db,params){
  const datasetId=params.get('datasetId');requireThat(datasetId,'datasetId required');
  const ds=await datasetTime(db,datasetId);if(!ds)fail(404,'NOT_FOUND','Dataset not provisioned');
  if(params.has('trackingRunId'))requireThat(params.get('trackingRunId')===ds.run_id,'Tracking run mismatch','RUN_CONFLICT',409);
  const size=limit(params);
  const page=await snapshotPage(db,JSON.stringify(['worker',datasetId,ds.run_id,size]),params.get('cursor'),async()=>{
    const rows=await collection(db,'clouds').find({dataset_id:datasetId}).sort({id:1}).toArray();
    const eligible=rows.filter(c=>!c.deleted_at&&(!c.payload.expiresAt||Date.parse(c.payload.expiresAt)>ds.clock.getTime())).map(c=>c.id);
    const messages=(await collection(db,'messages').find({cloud_id:{$in:eligible},expired_at:null}).sort({id:1}).toArray()).map(m=>({type:'message',value:{id:m.id,cloudId:m.cloud_id,version:m.payload.version,anchor:m.payload.anchor,updatedAt:m.payload.updatedAt,positionAt:m.position_at.toISOString(),artworkControlPoints:m.payload.artworkTransform?.controlPoints??[],expiredAt:null}}));
    return {items:[...rows.map(c=>({type:'cloud',value:c.payload})),...messages],meta:{datasetId,trackingRunId:ds.run_id,sequence:ds.sequence}};
  },size);
  return {data:{...page.meta,clouds:page.items.filter(x=>x.type==='cloud').map(x=>x.value),messages:page.items.filter(x=>x.type==='message').map(x=>x.value)},nextCursor:page.nextCursor};
}
