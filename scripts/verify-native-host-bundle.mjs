import {spawnSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const fail=code=>{throw new Error(code);};
const entryUrl=new URL('../dist-native-host/rbridge-native-host.cjs',import.meta.url);
const entry=fileURLToPath(entryUrl);
const info=await stat(entryUrl).catch(()=>fail('RBRIDGE_NATIVE_BUNDLE_MISSING'));
if(!info.isFile()||info.size<1024||info.size>2*1024*1024)fail('RBRIDGE_NATIVE_BUNDLE_SIZE_INVALID');
const source=await readFile(entryUrl,'utf8');
for(const required of ['RBRIDGE_NATIVE_CONFIG_ENV_REQUIRED','RBRIDGE_NATIVE_BOOTSTRAP','com.cocwin.rbridge_chat_v1']){
  if(!source.includes(required))fail('RBRIDGE_NATIVE_BUNDLE_MISSING:'+required);
}
const syntax=spawnSync(process.execPath,['--check',entry],{encoding:'utf8'});
if(syntax.status!==0)fail('RBRIDGE_NATIVE_BUNDLE_SYNTAX_INVALID');
const missing=fileURLToPath(new URL('../dist-native-host/__missing_config__.json',import.meta.url));
const smoke=spawnSync(process.execPath,[entry],{
  encoding:'utf8',
  env:{...process.env,RBRIDGE_NATIVE_HOST_CONFIG:missing},
  timeout:10000,
});
if(smoke.status!==70)fail('RBRIDGE_NATIVE_BUNDLE_SMOKE_EXIT_INVALID');
if(String(smoke.stdout??'').length!==0)fail('RBRIDGE_NATIVE_BUNDLE_STDOUT_NOT_PROTOCOL_CLEAN');
if(!String(smoke.stderr??'').includes('RBRIDGE_NATIVE_BOOTSTRAP=RBRIDGE_NATIVE_CONFIG_NOT_FOUND'))fail('RBRIDGE_NATIVE_BUNDLE_SMOKE_ERROR_INVALID');
console.log(JSON.stringify({schema:'RBRIDGE_NATIVE_HOST_BUNDLE_VERIFY_V1',status:'PASS',bytes:info.size}));
