import {readFile,stat} from 'node:fs/promises';

const base=new URL('../dist-extension/',import.meta.url);
const fail=code=>{throw new Error(code);};
const expectedSha=process.env.RBRIDGE_RELEASE_SHA??process.env.GITHUB_SHA??'';
if(!/^[0-9a-f]{40}$/.test(expectedSha))fail('RBRIDGE_EXTENSION_VERIFY_RELEASE_SHA_REQUIRED');

const [manifestText,contentScript,serviceWorker,contentStat,workerStat]=await Promise.all([
  readFile(new URL('manifest.json',base),'utf8'),
  readFile(new URL('contentScript.js',base),'utf8'),
  readFile(new URL('serviceWorker.js',base),'utf8'),
  stat(new URL('contentScript.js',base)),
  stat(new URL('serviceWorker.js',base)),
]);
let manifest;try{manifest=JSON.parse(manifestText);}catch{fail('RBRIDGE_EXTENSION_MANIFEST_JSON_INVALID');}

const exactSet=(actual,expected)=>Array.isArray(actual)&&actual.length===expected.length&&expected.every(value=>actual.includes(value));
if(manifest.manifest_version!==3||manifest.background?.service_worker!=='serviceWorker.js'||manifest.background?.type!=='module')fail('RBRIDGE_EXTENSION_MANIFEST_BACKGROUND_INVALID');
if(!exactSet(manifest.permissions,['tabs','scripting','storage','nativeMessaging']))fail('RBRIDGE_EXTENSION_MANIFEST_PERMISSIONS_INVALID');
if(!exactSet(manifest.host_permissions,['https://chatgpt.com/*','https://www.chatgpt.com/*','https://chat.openai.com/*','https://www.chat.openai.com/*']))fail('RBRIDGE_EXTENSION_MANIFEST_HOSTS_INVALID');
if('content_scripts' in manifest||manifest.permissions.includes('debugger'))fail('RBRIDGE_EXTENSION_MANIFEST_AUTHORITY_TOO_BROAD');
if(contentStat.size>512*1024||workerStat.size>512*1024)fail('RBRIDGE_EXTENSION_BUNDLE_TOO_LARGE');

for(const forbidden of ['connectNative','com.cocwin.rbridge_chat_v1','knownHostsFile','identityFile','-oBatchMode=yes']){
  if(contentScript.includes(forbidden))fail('RBRIDGE_CONTENT_BUNDLE_AUTHORITY_LEAK:'+forbidden);
}
for(const required of ['RBRIDGE_CONTENT_REQUEST_V1','RBRIDGE_CONTENT_CAPTURE_V1']){
  if(!contentScript.includes(required))fail('RBRIDGE_CONTENT_BUNDLE_MISSING:'+required);
}

for(const forbidden of ['prompt-textarea','data-message-author-role','MutationObserver','RBRIDGE_CONTENT_REQUEST_V1']){
  if(serviceWorker.includes(forbidden))fail('RBRIDGE_WORKER_BUNDLE_DOM_LEAK:'+forbidden);
}
for(const required of ['RBRIDGE_CHAT_HELLO_V1','com.cocwin.rbridge_chat_v1',expectedSha]){
  if(!serviceWorker.includes(required))fail('RBRIDGE_WORKER_BUNDLE_MISSING:'+required);
}

console.log(JSON.stringify({
  schema:'RBRIDGE_EXTENSION_ARTIFACT_VERIFY_V1',
  status:'PASS',
  releaseSha:expectedSha,
  contentBytes:contentStat.size,
  workerBytes:workerStat.size,
  manifestVersion:manifest.version,
}));
