import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
async function check(dir) {
  for(const file of await readdir(dir,{withFileTypes:true})) {
    if(file.name==='node_modules') continue;
    const url=new URL(file.name+(file.isDirectory()?'/':''),dir);
    if(file.isDirectory()) await check(url);
    else if(file.name.endsWith('.mjs')) {
      const result=spawnSync(process.execPath,['--check',fileURLToPath(url)],{encoding:'utf8'});
      if(result.status) {console.error(result.stderr);process.exitCode=1;}
    }
  }
}
await check(new URL('./',import.meta.url));
