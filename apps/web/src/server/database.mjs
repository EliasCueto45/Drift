import pg from 'pg';

let pool;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
}

// MVP deliberately serializes DB operations across all web/cleanup processes.
// The same lock prevents posting to a retiring cloud and cleanup/vote races.
// Replace with ordered per-dataset/row locks only after contention is measured.
export async function transaction(fn, source = database()) {
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(74102026)");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
export async function closeDatabase() { if (pool) { await pool.end(); pool = undefined; } }
export async function one(db, sql, params = []) { return (await db.query(sql, params)).rows[0]; }
export async function datasetTime(db, id) {
  const row = await one(db, `SELECT *, CASE WHEN mode='replay' THEN observed_at ELSE now() END AS clock FROM datasets WHERE id=$1`, [id]);
  return row;
}
