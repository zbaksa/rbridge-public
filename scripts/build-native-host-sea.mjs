import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const fail=code=>{throw new Error(code);};
if(process.platform!=='win32')fail('RBRIDGE_NATIVE_SEA_WINDOWS_REQUIRED');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'dist-native-host');
const bundle=join(out,'rbridge-native-host.cjs');
const seaConfig=join(out,'sea-config.json');
const blob=join(out,'sea-prep.blob');
const exe=join(out,'rbridge-native-host.exe');
await stat(bundle).catch(()=>fail('RBRIDGE_NATIVE_BUNDLE_MISSING'));
await writeFile(seaConfig,JSON.stringify({
  main:bundle,
  output:blob,
  disableExperimentalSEAWarning:true,
  useSnapshot:false,
  useCodeCache:false,
},null,2)+'\n','utf8');
let run=spawnSync(process.execPath,['--experimental-sea-config',seaConfig],{stdio:'inherit'});
if(run.status!==0)fail('RBRIDGE_NATIVE_SEA_BLOB_FAILED');
await copyFile(process.execPath,exe);
run=spawnSync('npx.cmd',['--yes','postject@1.0.0-alpha.6',exe,'NODE_SEA_BLOB',blob,'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],{stdio:'inherit'});
if(run.status!==0)fail('RBRIDGE_NATIVE_SEA_INJECT_FAILED');
const bytes=await readFile(exe);
if(bytes.length<1024*1024||bytes[0]!==0x4d||bytes[1]!==0x5a)fail('RBRIDGE_NATIVE_SEA_PE_INVALID');
const missing=join(out,'__missing_config__.json');
const smoke=spawnSync(exe,[],{encoding:'utf8',env:{...process.env,RBRIDGE_NATIVE_HOST_CONFIG:missing},timeout:10000});
if(smoke.status!==70)fail('RBRIDGE_NATIVE_SEA_SMOKE_EXIT_INVALID');
if(String(smoke.stdout??'').length!==0)fail('RBRIDGE_NATIVE_SEA_STDOUT_NOT_PROTOCOL_CLEAN');
if(!String(smoke.stderr??'').includes('RBRIDGE_NATIVE_BOOTSTRAP=RBRIDGE_NATIVE_CONFIG_NOT_FOUND'))fail('RBRIDGE_NATIVE_SEA_SMOKE_ERROR_INVALID');
const sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(join(out,'rbridge-native-host.metadata.json'),JSON.stringify({
  schema:'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1',
  status:'PASS',
  nodeVersion:process.version,
  postjectVersion:'1.0.0-alpha.6',
  sha256,
  bytes:bytes.length,
},null,2)+'\n','utf8');
await rm(seaConfig,{force:true});await rm(blob,{force:true});
console.log(JSON.stringify({schema:'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_BUILD_V1',status:'PASS',sha256,bytes:bytes.length}));
