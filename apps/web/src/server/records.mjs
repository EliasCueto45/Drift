import { one, datasetTime } from './database.mjs';
import { fail, requireThat } from './validation.mjs';

export const pointSQL = 'ST_SetSRID(ST_MakePoint($1,$2),4326)';
export async function cloudRecord(db, id) {
  const c = await one(db, 'SELECT * FROM clouds WHERE id=$1', [id]);
  if (!c) fail(404, 'NOT_FOUND', 'Cloud not found');
  const ds = await datasetTime(db, c.dataset_id);
  const elapsed = c.payload.expiresAt && Date.parse(c.payload.expiresAt) <= ds.clock.getTime();
  return { ...c, ds, expired: !!c.deleted_at || c.payload.status === 'expired' || !!elapsed };
}
export async function successors(db, id) {
  return (await db.query(`SELECT id FROM clouds WHERE payload->'parentIds' ? $1 ORDER BY id`, [id])).rows.map(r => r.id);
}
export async function activeCloud(db, id, version) {
  const c = await cloudRecord(db, id);
  const next = await successors(db, id);
  if (next.length) fail(409, 'CLOUD_RETIRED', `Cloud retired; successor IDs: ${JSON.stringify(next)}`);
  if (c.expired) fail(410, 'CLOUD_EXPIRED', 'Cloud expired');
  requireThat(c.payload.status === 'active', 'Cloud is not eligible for posting', 'CLOUD_UNAVAILABLE', 409);
  if (version !== undefined) requireThat(c.payload.version === version, 'Cloud version changed', 'VERSION_CONFLICT', 409);
  return c;
}
export async function saveCloud(db, cloud) {
  await db.query(`INSERT INTO clouds(id,dataset_id,payload,footprint) VALUES($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326))
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,footprint=EXCLUDED.footprint`, [cloud.id, cloud.datasetId, cloud, JSON.stringify(cloud.geometry)]);
  await db.query('INSERT INTO cloud_history(cloud_id,version,payload) VALUES($1,$2,$3)', [cloud.id, cloud.version, cloud]);
}
export async function contains(db, cloudId, anchor) {
  const r = await one(db, `SELECT ST_Covers(footprint,ST_SetSRID(ST_MakePoint($2,$3),4326)) AS yes FROM clouds WHERE id=$1`, [cloudId,anchor.longitude,anchor.latitude]);
  requireThat(r?.yes, 'Anchor must be inside cloud footprint');
}
export async function geometryValid(db, geometry) {
  const r = await one(db, `SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AS yes FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) g) x`, [JSON.stringify(geometry)]);
  requireThat(r.yes, 'Invalid geographic polygon');
}
export async function messageRecord(db, id) {
  const m = await one(db, 'SELECT * FROM messages WHERE id=$1', [id]);
  if (!m) fail(404, 'NOT_FOUND', 'Message not found'); return m;
}
export async function publicMessage(db, row, viewerId) {
  const c = await cloudRecord(db, row.cloud_id);
  if (row.expired_at || row.held || c.expired || c.payload.status === 'out_of_region') return null;
  const votes = await one(db, `SELECT count(*)::integer AS count,coalesce(bool_or(user_id=$2),false) AS voted FROM votes WHERE message_id=$1`, [row.id,viewerId ?? null]);
  return { ...row.payload, voteCount: votes.count, viewerHasUpvoted: votes.voted };
}
export async function expireMessage(db, id, at) {
  await db.query(`UPDATE messages SET expired_at=$2::text::timestamptz,payload=jsonb_set(jsonb_set(jsonb_set(payload,'{expiredAt}',to_jsonb($2::text)),'{updatedAt}',to_jsonb($2::text)),'{version}',to_jsonb((payload->>'version')::integer+1)) WHERE id=$1 AND expired_at IS NULL`, [id,at]);
  await db.query(`INSERT INTO cleanup_jobs(message_id) SELECT id FROM messages WHERE id=$1 ON CONFLICT DO NOTHING`, [id]);
}
