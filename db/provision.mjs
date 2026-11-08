import { transaction,closeDatabase } from '../apps/web/src/server/database.mjs';

const [id,mode,runId,start] = process.argv.slice(2);
if(!id || !['live','replay'].includes(mode) || !runId || !start?.endsWith('Z') || !Number.isFinite(Date.parse(start))) {
  throw new Error('Usage: node db/provision.mjs DATASET_ID live|replay RUN_ID START_UTC');
}
try {
  await transaction(db=>db.query('INSERT INTO datasets(id,mode,run_id,observed_at) VALUES($1,$2,$3,$4)',[id,mode,runId,start]));
  console.log('Provisioned dataset at sequence 0');
} finally {await closeDatabase();}
