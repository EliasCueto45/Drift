import { database,closeDatabase } from '../apps/web/src/server/database.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

await runCli(async()=>{await database();console.log('MongoDB collections and indexes initialized (schema version 2).');},closeDatabase);
