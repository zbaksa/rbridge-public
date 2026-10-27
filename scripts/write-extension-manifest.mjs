import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {buildRbridgeExtensionManifest} from '../dist/src/extension/extensionManifest.js';
import {extensionBuildProfile} from './extension-build-profile.mjs';

const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const version=String(pkg.version||'0.1.0').split('-')[0];
const manifest=buildRbridgeExtensionManifest(version);
const output=new URL('../'+extensionBuildProfile().outDir+'/',import.meta.url);
await mkdir(output,{recursive:true});
await writeFile(new URL('manifest.json',output),JSON.stringify(manifest,null,2)+'\n','utf8');
