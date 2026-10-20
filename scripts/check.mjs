import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'extension/manifest.json'),'utf8'));
if(manifest.manifest_version!==3 || manifest.background.service_worker!=='background.js')throw new Error('Invalid extension manifest');
for(const folder of ['extension','server','scripts','test']) {
  for(const file of await readdir(path.join(root,folder))) {
    if(!/\.(?:mjs|js)$/.test(file))continue;
    const result=spawnSync(process.execPath,['--check',path.join(root,folder,file)],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status || 1);
  }
}
console.log('Manifest and JavaScript syntax checked.');
