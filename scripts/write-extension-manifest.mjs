import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {buildRbridgeExtensionManifest} from '../dist/src/extension/extensionManifest.js';

const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const version=String(pkg.version||'0.1.0').split('-')[0];
const manifest=buildRbridgeExtensionManifest(version);
await mkdir(new URL('../dist-extension/',import.meta.url),{recursive:true});
await writeFile(new URL('../dist-extension/manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n','utf8');
