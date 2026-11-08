import { database,transaction,closeDatabase } from '../apps/web/src/server/database.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

await runCli(async()=>{
  const source=await database();await source.db.command({ping:1});
  await transaction(async()=>({ok:true}),source);
  console.log('MongoDB connection, collection/index initialization, and transaction check passed.');
},closeDatabase);
