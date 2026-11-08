import './environment.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanup } from './cleanup.mjs';
import { transaction,closeDatabase } from './database.mjs';
import { runCli } from './cli.mjs';

const watch=process.argv.includes('--watch'),stop=new AbortController();
process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
await runCli(async()=>{
  do{
    const result=await transaction(db=>cleanup(db));console.log(JSON.stringify(result));
    if(result.failed&&!watch)process.exitCode=1;
    if(!watch||stop.signal.aborted)break;
    try{await delay(300000,undefined,{signal:stop.signal});}catch(error){if(error.name!=='AbortError')throw error;}
  }while(!stop.signal.aborted);
},closeDatabase);
