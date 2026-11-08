import { one } from './database.mjs';
import { contains, expireMessage, geometryValid, saveCloud } from './records.mjs';
import { fail, limit, requireThat, utc, validate } from './validation.mjs';
import { snapshotPage } from './pagination.mjs';

function unique(items, key) { requireThat(new Set(items.map(x=>x[key])).size === items.length, `Duplicate ${key}`); }
export async function ingest(db,batch) {
  validate('TrackingBatch',batch); utc(batch.observedAt);
  unique(batch.snapshots,'id'); unique(batch.events,'eventId'); unique(batch.anchorUpdates,'messageId');
  const old = await one(db,'SELECT * FROM tracking_batches WHERE batch_id=$1',[batch.batchId]);
  if (old) {
    requireThat(old.dataset_id === batch.datasetId,'Batch ID belongs to another dataset','BATCH_CONFLICT',409);
    return {data:old.acknowledgement};
  }
  let ds = await one(db,'SELECT * FROM datasets WHERE id=$1',[batch.datasetId]);
  // Only explicitly configured live/replay datasets are accepted. Fixture seed
  // provisions fx-* datasets; worker secrets cannot silently create a live run.
  if (!ds) fail(409,'DATASET_NOT_READY','Provision dataset/run before ingest');
  requireThat(ds.run_id === batch.trackingRunId,'Tracking run mismatch','RUN_CONFLICT',409);
  requireThat(batch.sequence === ds.sequence+1,`Expected sequence ${ds.sequence+1}`,'OUT_OF_ORDER',409);
  requireThat(Date.parse(batch.observedAt) >= ds.observed_at.getTime(),'Observation clock moved backwards','OUT_OF_ORDER',409);
  const existing = new Map();
  for (const cloud of batch.snapshots) {
    validate('Cloud',cloud); utc(cloud.updatedAt); utc(cloud.observedAt); utc(cloud.wind.validAt);
    requireThat(cloud.datasetId === batch.datasetId && cloud.trackingRunId === batch.trackingRunId,'Snapshot dataset/run mismatch');
    const prev = await one(db,'SELECT * FROM clouds WHERE id=$1',[cloud.id]); existing.set(cloud.id,prev);
    requireThat(!prev || prev.dataset_id === batch.datasetId,'Cross-dataset cloud','DATASET_CONFLICT',409);
    requireThat(cloud.version === (prev ? prev.payload.version+1 : 1),'Cloud version conflict','VERSION_CONFLICT',409);
    if (prev) {
      requireThat((!prev.deleted_at || cloud.status === 'expired') && !(prev.payload.status === 'expired' && cloud.status !== 'expired'),'Cloud cannot be resurrected','VERSION_CONFLICT',409);
      requireThat(cloud.kind === prev.payload.kind && cloud.creatorId === prev.payload.creatorId && cloud.expiresAt === prev.payload.expiresAt,'Immutable cloud fields changed');
    } else requireThat(cloud.kind === 'observed' && cloud.creatorId === null && cloud.expiresAt === null,'Worker cannot create user clouds');
    requireThat(Date.parse(cloud.updatedAt) <= Date.parse(batch.observedAt) && Date.parse(cloud.observedAt) <= Date.parse(batch.observedAt),'Snapshot time exceeds batch');
    await geometryValid(db,cloud.geometry);
    await saveCloud(db,cloud);
  }
  for (const cloud of batch.snapshots) {
    for (const parentId of cloud.parentIds) {
      const parent = await one(db,'SELECT * FROM clouds WHERE id=$1',[parentId]);
      requireThat(parent && parent.id !== cloud.id && parent.dataset_id === batch.datasetId && parent.payload.kind === 'observed' && cloud.kind === 'observed','Invalid lineage parent');
    }
    const cycle = await one(db,`WITH RECURSIVE ancestors(id) AS (
      SELECT jsonb_array_elements_text(payload->'parentIds') FROM clouds WHERE id=$1
      UNION SELECT jsonb_array_elements_text(c.payload->'parentIds') FROM clouds c JOIN ancestors a ON c.id=a.id
    ) SELECT 1 FROM ancestors WHERE id=$1 LIMIT 1`,[cloud.id]);
    requireThat(!cycle,'Cyclic cloud lineage');
  }
  for (const event of batch.events) {
    utc(event.effectiveAt);
    requireThat(Date.parse(event.effectiveAt) <= Date.parse(batch.observedAt),'Event time exceeds batch');
    for (const id of [...event.sourceCloudIds,...event.targetCloudIds]) {
      const row = await one(db,'SELECT * FROM clouds WHERE id=$1',[id]);
      requireThat(row && row.dataset_id === batch.datasetId,'Event references foreign or unknown cloud');
      if (['merged','split'].includes(event.type)) requireThat(row.payload.kind === 'observed','Created clouds cannot merge/split');
    }
    if (['merged','split'].includes(event.type)) {
      requireThat(event.sourceCloudIds.length > 0 && event.targetCloudIds.length > 0,'Lineage requires sources and targets');
      for (const id of event.sourceCloudIds) {
        const c = await one(db,'SELECT payload FROM clouds WHERE id=$1',[id]);
        requireThat(c.payload.status === 'expired','Lineage predecessors must retire');
      }
    }
    const collision = await one(db,'SELECT 1 FROM lifecycle_events WHERE event_id=$1',[event.eventId]);
    requireThat(!collision,'Event ID already used','EVENT_CONFLICT',409);
    await db.query('INSERT INTO lifecycle_events(event_id,dataset_id,payload) VALUES($1,$2,$3)',[event.eventId,batch.datasetId,event]);
  }
  for (const u of batch.anchorUpdates) {
    const row = await one(db,`SELECT m.*,c.dataset_id FROM messages m JOIN clouds c ON c.id=m.cloud_id WHERE m.id=$1`,[u.messageId]);
    requireThat(row && row.dataset_id === batch.datasetId && !row.expired_at && row.payload.version === u.expectedMessageVersion,'Message version conflict','VERSION_CONFLICT',409);
    const currentOrigin = await one(db,'SELECT payload FROM clouds WHERE id=$1',[row.cloud_id]);
    const oldOrigin = existing.get(row.cloud_id)?.payload ?? currentOrigin.payload;
    // Match the worker's geometric clock. Observed parcels can stop at the
    // prediction horizon even while batches/versions continue during an outage.
    const end = oldOrigin.kind === 'created' ? Date.parse(currentOrigin.payload.updatedAt) : Math.min(Date.parse(batch.observedAt),Date.parse(oldOrigin.observedAt)+1800000);
    const positionAt = new Date(Math.max(row.position_at.getTime(),end)).toISOString();
    let target = row.cloud_id;
    if (u.targetCloudId !== null) {
      const c = await one(db,'SELECT * FROM clouds WHERE id=$1',[u.targetCloudId]);
      requireThat(c && c.dataset_id === batch.datasetId,'Invalid transfer target');
      requireThat(c.payload.kind === (await one(db,'SELECT payload FROM clouds WHERE id=$1',[row.cloud_id])).payload.kind,'Cannot transfer between created/observed clouds');
      if (c.payload.kind === 'created') requireThat(c.id === row.cloud_id,'Created clouds are independent');
      if (u.action === 'move') {
        requireThat(c.payload.status !== 'expired','Cannot move into retired cloud');
        await contains(db,c.id,u.anchor); target = c.id;
      }
    }
    if (row.payload.artworkTransform && u.action !== 'expire') requireThat(u.artworkControlPoints?.length === row.payload.artworkTransform.controlPoints?.length,'Artwork transport requires all control points');
    const payload = {...row.payload,cloudId:target,anchor:u.anchor,version:row.payload.version+1,updatedAt:batch.observedAt};
    if (u.artworkControlPoints) {
      requireThat(payload.artworkTransform,'Control points require artwork');
      payload.artworkTransform = {...payload.artworkTransform,controlPoints:u.artworkControlPoints};
    }
    if (u.action === 'expire') payload.expiredAt = batch.observedAt;
    await db.query(`UPDATE messages SET cloud_id=$2,payload=$3,anchor=ST_SetSRID(ST_MakePoint($4,$5),4326),held=$6,position_at=$7,expired_at=$8 WHERE id=$1`,[row.id,target,payload,u.anchor.longitude,u.anchor.latitude,u.action==='hold',positionAt,payload.expiredAt]);
    if (u.action === 'expire') await expireMessage(db,row.id,batch.observedAt);
  }
  // Every parcel on a newly retired predecessor needs an explicit instruction.
  // This detects posts that arrived after the worker's state read and rolls back
  // the entire batch, allowing a refresh rather than silently losing content.
  for (const cloud of batch.snapshots.filter(c=>c.status==='expired')) {
    const untouched = await one(db,`SELECT id FROM messages WHERE cloud_id=$1 AND expired_at IS NULL AND NOT held LIMIT 1`,[cloud.id]);
    requireThat(!untouched,'Retired cloud still has unresolved messages','VERSION_CONFLICT',409);
  }
  await db.query('UPDATE datasets SET sequence=$2,observed_at=$3,received_at=now() WHERE id=$1',[batch.datasetId,batch.sequence,batch.observedAt]);
  const ack = {sequence:batch.sequence};
  await db.query('INSERT INTO tracking_batches(batch_id,dataset_id,sequence,acknowledgement) VALUES($1,$2,$3,$4)',[batch.batchId,batch.datasetId,batch.sequence,ack]);
  return {data:ack};
}
export async function trackingState(db,params) {
  const datasetId = params.get('datasetId'); requireThat(datasetId,'datasetId required');
  const ds = await one(db,'SELECT * FROM datasets WHERE id=$1',[datasetId]);
  if (!ds) fail(404,'NOT_FOUND','Dataset not provisioned');
  if (params.has('trackingRunId')) requireThat(params.get('trackingRunId')===ds.run_id,'Tracking run mismatch','RUN_CONFLICT',409);
  const size = limit(params);
  const page = await snapshotPage(db,JSON.stringify(['worker',datasetId,ds.run_id,size]),params.get('cursor'),async()=>{
    const clouds = (await db.query('SELECT payload FROM clouds WHERE dataset_id=$1 ORDER BY id',[datasetId])).rows.map(r=>({type:'cloud',value:r.payload}));
    const messages = (await db.query(`SELECT m.* FROM messages m JOIN clouds c ON c.id=m.cloud_id
      WHERE c.dataset_id=$1 AND m.expired_at IS NULL AND c.deleted_at IS NULL
      AND (c.payload->>'expiresAt' IS NULL OR (c.payload->>'expiresAt')::timestamptz > CASE WHEN $2='replay' THEN $3::timestamptz ELSE now() END) ORDER BY m.id`,[datasetId,ds.mode,ds.observed_at])).rows.map(m=>({type:'message',value:{id:m.id,cloudId:m.cloud_id,version:m.payload.version,anchor:m.payload.anchor,updatedAt:m.payload.updatedAt,positionAt:m.position_at.toISOString(),artworkControlPoints:m.payload.artworkTransform?.controlPoints??[],expiredAt:null}}));
    return {items:[...clouds,...messages],meta:{datasetId,trackingRunId:ds.run_id,sequence:ds.sequence}};
  },size);
  return {data:{...page.meta,clouds:page.items.filter(x=>x.type==='cloud').map(x=>x.value),messages:page.items.filter(x=>x.type==='message').map(x=>x.value)},nextCursor:page.nextCursor};
}
