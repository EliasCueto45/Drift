import { transaction,closeDatabase } from '../apps/web/src/server/database.mjs';
import { seedFixtures } from '../apps/web/src/server/fixtures.mjs';
import { runCli } from '../apps/web/src/server/cli.mjs';

await runCli(async()=>{
  const count=await seedFixtures(transaction);
  console.log(`Initialized ${count} synthetic fixture datasets; existing datasets were left intact.`);
},closeDatabase);
