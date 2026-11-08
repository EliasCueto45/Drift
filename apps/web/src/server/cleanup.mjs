import { one } from './database.mjs';
import { expireMessage } from './records.mjs';
import { storageClient, objectCommand, DeleteObjectCommand } from './storage.mjs';

export async function cleanup(db,makeClient=storageClient,batchSize=100) {
  const due=(await db.query(`SELECT m.id, CASE WHEN d.mode='replay' THEN d.observed_at ELSE now() END AS clock
    FROM messages m JOIN clouds c ON c.id=m.cloud_id JOIN datasets d ON d.id=c.dataset_id
    WHERE m.expired_at IS NULL AND (c.deleted_at IS NOT NULL OR (c.payload->>'expiresAt')::timestamptz <= CASE WHEN d.mode='replay' THEN d.observed_at ELSE now() END)
    LIMIT $1`,[batchSize])).rows;
  for(const m of due) await expireMessage(db,m.id,m.clock.toISOString());
  let completed=0,failed=0;
  for(const job of (await db.query('SELECT message_id FROM cleanup_jobs ORDER BY queued_at LIMIT $1',[batchSize])).rows) {
    const m=await one(db,'SELECT * FROM messages WHERE id=$1',[job.message_id]);
    try {
      if(m.asset_id) {
        const a=await one(db,'SELECT * FROM assets WHERE id=$1',[m.asset_id]);
        const client=makeClient();
        await client.send(objectCommand(DeleteObjectCommand,a.upload_key));
        await client.send(objectCommand(DeleteObjectCommand,a.object_key));
        await db.query("UPDATE assets SET payload=jsonb_set(payload,'{state}','\"deleted\"'::jsonb),attached_message_id=NULL WHERE id=$1",[a.id]);
      }
      await db.query('DELETE FROM cleanup_jobs WHERE message_id=$1',[m.id]);
      await db.query('DELETE FROM messages WHERE id=$1',[m.id]);
      completed++;
    } catch {
      // No body, media contents or credentials in logs/errors.
      await db.query('UPDATE cleanup_jobs SET attempts=attempts+1 WHERE message_id=$1',[m.id]); failed++;
    }
  }
  // Include ready-but-abandoned uploads and expired staging keys. Ready attached
  // assets only lose their staging object, so PUT retries cannot alter playback.
  const orphans=(await db.query(`SELECT * FROM assets WHERE payload->>'state'<>'deleted' AND upload_expires_at<now()
    AND (attached_message_id IS NOT NULL OR created_at<now()-interval '24 hours') LIMIT $1`,[batchSize])).rows;
  for(const a of orphans) {
    try {
      const client=makeClient(); await client.send(objectCommand(DeleteObjectCommand,a.upload_key));
      if(!a.attached_message_id) {
        await client.send(objectCommand(DeleteObjectCommand,a.object_key));
        await db.query("UPDATE assets SET payload=jsonb_set(payload,'{state}','\"deleted\"'::jsonb) WHERE id=$1",[a.id]);
      }
    } catch { failed++; }
  }
  await db.query('DELETE FROM query_snapshots WHERE expires_at<now()');
  await db.query("DELETE FROM rate_windows WHERE window_at<now()-interval '2 minutes'");
  return {completed,failed};
}
