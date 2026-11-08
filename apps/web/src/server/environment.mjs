import { existsSync,readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Next loads apps/web/.env.local itself. CLI processes also load the same file.
// Explicit process variables always win; no credential is logged.
const supplied=new Set(Object.keys(process.env));
for(const url of [new URL('../../../../.env',import.meta.url),new URL('../../.env.local',import.meta.url)]) {
  if(!existsSync(url)) continue;
  for(const [key,value] of Object.entries(parseEnv(readFileSync(url,'utf8')))) if(!supplied.has(key)) process.env[key]=value;
}
