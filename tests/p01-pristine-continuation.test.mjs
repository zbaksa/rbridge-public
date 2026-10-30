import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import {canonicalDigest} from '../dist/src/domain/rbridgeEffectProtocol.js';
import {RbridgeEffectStoreV1} from '../dist/src/extension/rbridgeEffectStore.js';
import {startProvisionedExtensionServiceWorkerV3} from '../dist/src/extension/serviceWorkerStartupV3.js';
const workerLocks={held:false,request:async(name,options,run)=>{assert.equal(name,'rbridge-p01-original-pristine-upgrade');if(workerLocks.held)return run(null);workerLocks.held=true;try{return await run({name});}finally{workerLocks.held=false;}}};
Object.defineProperty(globalThis.navigator,'locks',{value:workerLocks,configurable:true});
const START='rbridgeExtensionStartupV3',TX='rbridgeP01PristineContinuationV1';
const config=JSON.parse(await readFile('ops/p01-owner-generated/4786c8bd94d2/v3-peer-config.json','utf8'));
const {scope,peerPins:oldPeer}=config;
const sha=value=>createHash('sha256').update(value).digest('hex');
const original={schema:'RBRIDGE_EXTENSION_STARTUP_V3',extensionId:'ebibbijpegoankenmggdnehpoadcophk',releaseSha:oldPeer.releaseSha,bootstrap:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:oldPeer.browserInstanceId,browserProfileId:oldPeer.browserProfileId,nativeHostVersion:'rbridge-native-v3'},scope:{appId:scope.appId,baseSha:scope.baseSha,sessionId:scope.sessionId,generation:scope.generation},peer:{peerId:oldPeer.peerId,releaseSha:oldPeer.releaseSha,browserInstanceId:oldPeer.browserInstanceId,browserProfileId:oldPeer.browserProfileId,protocolMinor:oldPeer.protocolMinor,maxMessageBytes:oldPeer.maxMessageBytes,capabilities:oldPeer.capabilities},initialHistory:[],siteAdapter:'CHATGPT_EXACT_COPY_V3'};
const oldRaw=JSON.stringify(original);
assert.equal(sha(oldRaw),'fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5');
const release='a'.repeat(40),target={...original,releaseSha:release,peer:{...original.peer,releaseSha:release,capabilities:[...oldPeer.capabilities,'CHAT_SCOPE_QUIESCENCE_V1']}},targetRaw=JSON.stringify(target),pin=sha(targetRaw);
const setupSource=await readFile('scripts/p01-owner-setup.js','utf8');
const receipt=phase=>({schema:'COCWIN_P01_PRISTINE_CONTINUATION_V1',phase,predecessorRaw:oldRaw,predecessorSha256:sha(oldRaw),targetSha256:pin});
function harness(initial={[START]:oldRaw},options={}){
 const data=structuredClone(initial),elements=new Map(),writes=[],listeners=[],copies=[];
 let reloads=0,gets=0;
 const element=id=>{const item={id,textContent:'',disabled:false,addEventListener:(event,fn)=>{item[event]=fn;},insertAdjacentElement:(_,item)=>elements.set(item.id,item)};elements.set(id,item);return item;};
 element('activate');element('status');
 const chrome={runtime:{id:original.extensionId,getURL:p=>'chrome-extension://'+original.extensionId+'/'+p,reload:()=>{reloads++;},getManifest:()=>({name:'fixture'})},storage:{local:{
 get:async key=>{gets++;options.onGet?.(data,gets);return structuredClone(key===null?data:key in data?{[key]:data[key]}:{});},
 set:async patch=>{writes.push(structuredClone(patch));if(options.failWrite===writes.length)throw Error('SYNTHETIC_WRITE_FAILURE');Object.assign(data,structuredClone(patch));options.afterWrite?.(data,writes.length);},
 setAccessLevel:async()=>{options.onAccess?.(data);}},onChanged:{addListener:f=>listeners.push(f),removeListener:()=>{}}},
 tabs:{query:async()=>[{id:7,windowId:8,url:'https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'/c/fixture'}]}};
 const resourceTexts={'manifest.json':'{"manifest_version":3}', 'serviceWorker.js':'// SYNTHETIC WORKER BYTES', 'contentScript.js':'// SYNTHETIC CONTENT BYTES', 'p01-startup.json':targetRaw,'setup.html':'<!doctype html><!-- SYNTHETIC HTML -->','setup.js':setupSource.replace('__STARTUP_SHA256__',pin)};
 const context={document:{getElementById:id=>elements.get(id),createElement:()=>element('new')},chrome,crypto:webcrypto,TextEncoder,TextDecoder,URL,Uint8Array,console,fetch:async url=>{const path=new URL(url).pathname.slice(1),raw=resourceTexts[path];if(raw===undefined)throw Error('UNEXPECTED_RESOURCE:'+path);const bytes=new TextEncoder().encode(raw);let consumed=false;return {ok:true,text:async()=>raw,body:{getReader:()=>({read:async()=>{if(consumed)return {done:true};consumed=true;return {done:false,value:bytes};},cancel:async()=>{},releaseLock:()=>{}})}};},btoa:value=>Buffer.from(value,'binary').toString('base64'),navigator:{clipboard:{writeText:async value=>copies.push(value)},locks:options.locks??workerLocks},structuredClone};
 vm.runInNewContext(setupSource.replace('__STARTUP_SHA256__',pin),context,{filename:'setup.js'});
 return {data,writes,chrome,elements,copies,resourceTexts,reloads:()=>reloads,click:async()=>{await elements.get('activate').click();},status:()=>elements.get('status').textContent};
}
test('original pristine startup publishes READY only after complete snapshot verification',async()=>{
 const h=harness();await h.click();assert.equal(h.data[START],targetRaw,h.status());assert.deepEqual(h.data[TX],receipt('READY'));assert.equal(h.reloads(),1);assert.equal(h.data[TX].predecessorRaw,oldRaw);
});
for(const key of ['rbridgeBrowserAuthorityV1','rbridgeEffectLedgerV1','rbridgeCaptureOutboxV3','rbridgeUnknownHistory']){
 test('existing '+key+' prevents writes even with target startup',async()=>{for(const raw of [oldRaw,targetRaw]){const h=harness({[START]:raw,[key]:{}});await h.click();assert.equal(h.writes.length,0);assert.equal(h.reloads(),0);}});
}
test('missing or different startup and mismatched bootstrap remain unchanged',async()=>{
 for(const state of [{},{[START]:oldRaw+'\n'},{[START]:oldRaw,rbridgeExtensionBootstrapV1:{...original.bootstrap,browserProfileId:'other'}}]){
 const h=harness(state);await h.click();assert.equal(h.writes.length,0);assert.equal(h.reloads(),0);
 }
});
test('same identity bootstrap is preserved byte for byte',async()=>{const h=harness({[START]:oldRaw,rbridgeExtensionBootstrapV1:original.bootstrap});await h.click();assert.equal(h.data[START],targetRaw,h.status());assert.deepEqual(h.data.rbridgeExtensionBootstrapV1,original.bootstrap);});
test('racing history or predecessor change blocks publication',async()=>{
 for(const mutate of [data=>{data.rbridgeEffectLedgerV1={uncertain:true};},data=>{data[START]=oldRaw+'\n';},data=>{data.rbridgeExtensionBootstrapV1={...original.bootstrap,browserInstanceId:'other'};}]){
 const h=harness({[START]:oldRaw},{onAccess:mutate});await h.click();assert.equal(h.reloads(),0);assert.equal(h.writes.some(row=>row[START]===targetRaw),false);
 }
});
test('partial transaction never reloads and ambiguous retry never writes',async()=>{
 for(const failWrite of [1,2,3]){
 const h=harness({[START]:oldRaw},{failWrite});await h.click();assert.equal(h.reloads(),0);const before=structuredClone(h.data);const retry=harness(before);await retry.click();
 if(before[TX]){assert.deepEqual(retry.data,before);assert.equal(retry.writes.length,0);assert.equal(retry.reloads(),0);}
 }
});
test('exact READY handoff replays without writes but missing/colliding receipts block',async()=>{
 const complete=harness({[START]:targetRaw,[TX]:receipt('READY')});await complete.click();assert.equal(complete.reloads(),1,complete.status());assert.equal(complete.writes.length,0);
 for(const tx of [undefined,receipt('PREPARED'),{...receipt('COMPLETE'),targetSha256:'b'.repeat(64)},{...receipt('COMPLETE'),predecessorRaw:oldRaw+'\n'}]){
 const state={[START]:targetRaw};if(tx!==undefined)state[TX]=tx;
 const h=harness(state);await h.click();assert.equal(h.reloads(),0);assert.equal(h.writes.length,0);
 }
});
test('both read-only exports preserve storage and installed export hashes exactly six actual resources',async()=>{
 const h=harness(),before=structuredClone(h.data);
 await h.elements.get('copy-p01-proof').click();
 const readonly=JSON.parse(h.copies.at(-1));assert.equal(readonly.schema,'COCWIN_P01_OWNER_READONLY_REPORT_V1');assert.equal(readonly.target.peerId,'peer-p01-3df7237d6ad64894cbeb');
 await h.elements.get('copy-installed-proof').click();
 const proof=JSON.parse(h.copies.at(-1));assert.equal(proof.schema,'COCWIN_P01_OWNER_INSTALLED_EXTENSION_PROOF_V1');
 assert.deepEqual(proof.resources.map(row=>row.path),['manifest.json','serviceWorker.js','contentScript.js','p01-startup.json','setup.html','setup.js']);
 for(const record of proof.resources){const expected=Buffer.from(h.resourceTexts[record.path]);assert.equal(record.bytes,expected.length);assert.equal(record.sha256,sha(expected));assert.equal(record.base64,expected.toString('base64'));}
 assert.equal(proof.storedStartup.base64,Buffer.from(oldRaw).toString('base64'));assert.equal(proof.browserSends,0);assert.equal(proof.storageWrites,0);
 assert.deepEqual(h.data,before);assert.equal(h.writes.length,0);assert.equal(h.reloads(),0);
});
function workerHarness(tx,mutate,options={}){
 const data={[START]:targetRaw};if(tx!==undefined)data[TX]=tx;let connected=0,gets=0;const writes=[];
 const local={get:async keys=>{gets++;mutate?.(data,gets);if(keys===null)return structuredClone(data);if(Array.isArray(keys))return Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));return keys in data?{[keys]:structuredClone(data[keys])}:{};},set:async patch=>{writes.push(structuredClone(patch));Object.assign(data,structuredClone(patch));options.afterSet?.(data,writes.length);},setAccessLevel:async()=>{}};
 const port={postMessage:()=>{},disconnect:()=>{},onMessage:{addListener:()=>{}},onDisconnect:{addListener:()=>{}}};
 const api={runtime:{id:original.extensionId,connectNative:()=>{connected++;return port;}},storage:{local},tabs:{get:async()=>{},query:async()=>[],sendMessage:async()=>{}},scripting:{executeScript:async()=>{}}};
 return {api,data,writes,count:()=>connected};
}
test('worker rejects partial/colliding continuation before Native connection',async()=>{
 for(const tx of [receipt('COMPLETE'),receipt('PREPARED'),null,{}, {...receipt('COMPLETE'),predecessorRaw:oldRaw+'\n'}, {...receipt('COMPLETE'),targetSha256:'b'.repeat(64)}]){
 const h=workerHarness(tx);await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
 }
});
test('worker admits exact READY original-scope handoff',async()=>{
 const h=workerHarness(receipt('READY')),worker=await startProvisionedExtensionServiceWorkerV3(h.api,release,pin);try{assert.equal(h.count(),1);}finally{worker.link.disconnect();}
});
test('worker detects continuation changed during digest awaits',async()=>{
 const h=workerHarness(receipt('READY'),(data,n)=>{if(n===3)data[TX]=receipt('PREPARED');});await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
});

test('worker rereads transaction after composition store awaits immediately before connection',async()=>{
 const h=workerHarness(receipt('READY'),(data,n)=>{if(n===6)data[TX]=receipt('PREPARED');});await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
});

test('READY handoff remains a pristine candidate in the untrusted read-only summary',async()=>{
 const h=harness({[START]:targetRaw,[TX]:receipt('READY')});await h.elements.get('copy-p01-proof').click();
 const report=JSON.parse(h.copies.at(-1));assert.equal(report.local.initialBindCandidate,true);assert.equal(report.local.status,'UNTRUSTED_LOCAL_OBSERVATION');assert.equal(h.writes.length,0);
});
test('same bootstrap fields in another object order remain the same public identity',async()=>{
 const bootstrap=Object.fromEntries(Object.entries(original.bootstrap).reverse()),h=harness({[START]:oldRaw,rbridgeExtensionBootstrapV1:bootstrap});await h.click();assert.equal(h.data[START],targetRaw,h.status());assert.deepEqual(h.data.rbridgeExtensionBootstrapV1,bootstrap);
});

// Independent review regressions: absence and rejected first handoffs are not admission.
test('original P01 target with no continuation cannot connect Native',async()=>{
 const h=workerHarness(undefined);await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
});
test('unrelated provisioned session keeps no-continuation compatibility',async()=>{
 const generic={...target,scope:{...target.scope,sessionId:'exta-'+ '1'.repeat(32)}},raw=JSON.stringify(generic),h=workerHarness(undefined);h.data[START]=raw;
 const worker=await startProvisionedExtensionServiceWorkerV3(h.api,release,sha(raw));try{assert.equal(h.count(),1);}finally{worker.link.disconnect();}
});
test('history colliding with COMPLETE publication remains blocked across worker restart',async()=>{
 const setup=harness({[START]:oldRaw},{afterWrite:(data,n)=>{if(n===3)data.rbridgeUnknownHistory={uncertain:true};}});
 await setup.click();assert.equal(setup.reloads(),0);assert.match(setup.status(),/BLOKIRANO/);
 const restarted=workerHarness(setup.data[TX]);Object.assign(restarted.data,structuredClone(setup.data));
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(restarted.api,release,pin));assert.equal(restarted.count(),0);
});
test('failure reading back COMPLETE never promotes a later worker restart',async()=>{
 const setup=harness({[START]:oldRaw},{onGet:(_,n)=>{if(n===6)throw Error('SYNTHETIC_FINAL_READ_FAILURE');}});
 await setup.click();assert.equal(setup.reloads(),0);assert.equal(setup.data[TX].phase,'COMPLETE');
 const restarted=workerHarness(setup.data[TX]);Object.assign(restarted.data,structuredClone(setup.data));
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(restarted.api,release,pin));assert.equal(restarted.count(),0);
});
test('untrusted summary rejects missing handoff receipt or conflicting bootstrap',async()=>{
 for(const rows of [{[START]:targetRaw},{[START]:targetRaw,[TX]:receipt('READY'),rbridgeExtensionBootstrapV1:{...original.bootstrap,browserProfileId:'conflicting'}}]){
 const h=harness(rows);await h.elements.get('copy-p01-proof').click();const report=JSON.parse(h.copies.at(-1));assert.equal(report.local.initialBindCandidate,false);assert.equal(h.writes.length,0);
 }
});

test('READY publication uncertainty reconciles only a fresh pristine worker snapshot',async()=>{
 const setup=harness({[START]:oldRaw},{afterWrite:(_,n)=>{if(n===4)throw Error('SYNTHETIC_READY_APPLIED_THEN_FAILED');}});
 await setup.click();assert.equal(setup.reloads(),0);assert.equal(setup.data[TX].phase,'READY');
 const workerState=workerHarness(setup.data[TX]);Object.assign(workerState.data,structuredClone(setup.data));
 const worker=await startProvisionedExtensionServiceWorkerV3(workerState.api,release,pin);
 try{assert.equal(workerState.count(),1);assert.equal(workerState.data[TX].phase,'ADMITTED');assert.equal(workerState.data[TX].predecessorRaw,oldRaw);}finally{worker.link.disconnect();}
});
test('ADMITTED publication applied then failed never connects on that attempt',async()=>{
 const state=workerHarness(receipt('READY'),undefined,{afterSet:()=>{throw Error('SYNTHETIC_ADMISSION_APPLIED_THEN_FAILED');}});
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(state.api,release,pin));assert.equal(state.count(),0);assert.equal(state.data[TX].phase,'ADMITTED');
 const restart=workerHarness(state.data[TX]);restart.data.rbridgeUnknownHistory={uncertain:true};
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(restart.api,release,pin));assert.equal(restart.count(),0);
});
test('same WebLock excludes worker admission throughout setup and Native connect',async()=>{
 workerLocks.held=true;
 try{const h=workerHarness(receipt('READY'));await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);}finally{workerLocks.held=false;}
 const h=workerHarness(receipt('READY'));h.api.runtime.connectNative=()=>{assert.equal(workerLocks.held,true);return {postMessage:()=>{},disconnect:()=>{},onMessage:{addListener:()=>{}},onDisconnect:{addListener:()=>{}}};};
 const worker=await startProvisionedExtensionServiceWorkerV3(h.api,release,pin);worker.link.disconnect();
});
test('every unknown key and corrupt known runtime record blocks ADMITTED restart',async()=>{
 for(const key of ['rbridgeUnknownHistory','rbridgeEffectLedgerV1','rbridgeSiteCaptureActivityV1','rbridgeCaptureOutboxV3','rbridgeScopeStopV1','rbridgeBrowserAuthorityV1']){
 const h=workerHarness(receipt('ADMITTED'));h.data[key]={corrupt:true};
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
 }
 const h=workerHarness(receipt('ADMITTED'));h.data.rbridgeExtensionBootstrapV1={...original.bootstrap,browserProfileId:'other'};
 await assert.rejects(()=>startProvisionedExtensionServiceWorkerV3(h.api,release,pin));assert.equal(h.count(),0);
});
test('legitimate runtime ledger written by the real effect store survives ADMITTED restart unchanged',async()=>{
 const first=workerHarness(receipt('READY')),worker=await startProvisionedExtensionServiceWorkerV3(first.api,release,pin);worker.link.disconnect();
 const attemptId=scope.sessionId+':a:1',effectKind='RBRIDGE_BIND';
 const requestBody={schema:'COCWIN_RBRIDGE_EFFECT_REQUEST_V1',...scope,attemptId,effectId:sha([scope.sessionId,scope.generation,attemptId,effectKind,'1'].join('\0')),effectKind,effectOrdinal:1,createdAt:'2026-10-30T00:00:00.000Z',payload:{target:{browserInstanceId:oldPeer.browserInstanceId,browserProfileId:oldPeer.browserProfileId,windowId:8,tabId:7,origin:'https://chatgpt.com',canonicalProjectId:'g-p-'+ 'a'.repeat(32),projectId:'g-p-'+ 'a'.repeat(32),conversationId:'synthetic-legitimate-history',conversationGeneration:1}}};
 const request={...requestBody,requestDigest:await canonicalDigest(requestBody)},commandBody={schema:'RBRIDGE_CHAT_EFFECT_COMMAND_V1',commandId:'synthetic-postadmission-reconcile',action:'RECONCILE',issuedAt:'2026-10-30T00:00:00.000Z',request};
 await new RbridgeEffectStoreV1(first.api.storage.local).reserve({...commandBody,commandSha256:await canonicalDigest(commandBody)});
 const before=structuredClone(first.data),restart=workerHarness(before[TX]);Object.assign(restart.data,before);
 const resumed=await startProvisionedExtensionServiceWorkerV3(restart.api,release,pin);try{assert.equal(restart.count(),1);assert.deepEqual(restart.data,before);}finally{resumed.link.disconnect();}
});

for(const [label,phase] of [['READY array',['READY']],['ADMITTED array',['ADMITTED']],['empty array',[]],['object',{}],['null',null],['boolean',true],['number',1],['boxed READY',new String('READY')]]){
 test('worker rejects non-string continuation phase: '+label,async()=>{
  const h=workerHarness(receipt(phase)),before=structuredClone(h.data);
  let worker;
  try{
   await assert.rejects(async()=>{worker=await startProvisionedExtensionServiceWorkerV3(h.api,release,pin);},/RBRIDGE_P01_CONTINUATION_BLOCKED/);
   assert.equal(h.writes.length,0);assert.equal(h.count(),0);assert.deepEqual(h.data,before);
  }finally{worker?.link.disconnect();}
 });
}
test('primitive READY publishes one ADMITTED receipt and pristine ADMITTED restart writes nothing',async()=>{
 const first=workerHarness(receipt('READY')),worker=await startProvisionedExtensionServiceWorkerV3(first.api,release,pin);
 try{assert.equal(first.count(),1);assert.deepEqual(first.writes,[{[TX]:receipt('ADMITTED')}]);}finally{worker.link.disconnect();}
 const restart=workerHarness(receipt('ADMITTED')),before=structuredClone(restart.data),resumed=await startProvisionedExtensionServiceWorkerV3(restart.api,release,pin);
 try{assert.equal(restart.count(),1);assert.equal(restart.writes.length,0);assert.deepEqual(restart.data,before);}finally{resumed.link.disconnect();}
});
