import { cleanup } from './cleanup.mjs';
import { transaction,closeDatabase } from './database.mjs';
try { const result=await transaction(db=>cleanup(db)); console.log(JSON.stringify(result)); if(result.failed) process.exitCode=1; }
finally { await closeDatabase(); }
