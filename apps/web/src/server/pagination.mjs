import { randomUUID } from 'node:crypto';
import { one } from './database.mjs';
import { fail, requireThat } from './validation.mjs';

export async function snapshotPage(db, binding, cursor, make, size = 50) {
  let id, offset = 0, payload;
  if (cursor) {
    const parts = cursor.split('.');
    requireThat(parts.length === 2 && /^[0-9]+$/.test(parts[1]), 'Invalid cursor');
    [id] = parts; offset = Number(parts[1]);
    requireThat(Number.isSafeInteger(offset) && offset >= 0, 'Invalid cursor');
    const row = await one(db, 'SELECT payload FROM query_snapshots WHERE id=$1 AND binding=$2 AND expires_at>now()', [id,binding]);
    if (!row) fail(409, 'CURSOR_EXPIRED', 'Refresh this query'); payload = row.payload;
  } else {
    id = randomUUID(); payload = await make();
    await db.query('INSERT INTO query_snapshots(id,binding,payload) VALUES($1,$2,$3)', [id,binding,JSON.stringify(payload)]);
  }
  requireThat(offset <= payload.items.length, 'Invalid cursor offset');
  const end = Math.min(offset + size, payload.items.length);
  return { items: payload.items.slice(offset,end), meta: payload.meta, nextCursor: end < payload.items.length ? `${id}.${end}` : null };
}
