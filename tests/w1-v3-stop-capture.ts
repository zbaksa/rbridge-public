import assert from 'node:assert/strict';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1} from '../src/extension/browserAuthorityRuntime.js';
import {BrowserAuthorityStoreV1,type BrowserAuthoritySnapshotV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {prepareBinding,verifyBinding,acquireWriteLeader,activateCapture,createSendTransaction,markSendReady,persistSendIntent,markSendUncertain,type BrowserTargetObservationV1} from '../src/domain/rbridgeChatCore.js';
import type {V3Scope} from '../src/domain/rbridgeEffectProtocol.js';
const sessionId='exta-'+'1'.repeat(32),generation='22222222-2222-4222-8222-222222222222';
const scope:V3Scope={appId:'cocwin',baseSha:'3'.repeat(40),sessionId,generation};
const target:BrowserTargetObservationV1={sessionId,generation,browserInstanceId:'fixture-browser',browserProfileId:'fixture-profile',windowId:1,tabId:2,origin:'https://chatgpt.com',projectId:'fixture-project',conversationId:'fixture-conversation',conversationGeneration:1,ownerSessionId:sessionId};
class Storage implements ChromeStorageAreaV1{
 data:Record<string,unknown>={};beforeGet:(()=>void)|undefined;beforeSet:(()=>void)|undefined;afterSet:(()=>void)|undefined;
 async get(key:string){this.beforeGet?.();return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
 async set(values:Record<string,unknown>){this.beforeSet?.();Object.assign(this.data,structuredClone(values));this.afterSet?.();}
}
type StopRuntime=BrowserAuthorityRuntimeV1&{stopScopeCapture?:(expected:BrowserAuthoritySnapshotV1,scope:V3Scope)=>Promise<BrowserAuthoritySnapshotV1>};
async function stop(runtime:BrowserAuthorityRuntimeV1,expected:BrowserAuthoritySnapshotV1,s=scope){const method=(runtime as StopRuntime).stopScopeCapture;assert.equal(typeof method,'function','missing stopScopeCapture behavior');return await method!.call(runtime,expected,s);}
async function fixture(){
 const storage=new Storage(),store=new BrowserAuthorityStoreV1(storage),now=new Date('2026-10-29T21:00:00.000Z');
 const verified=await verifyBinding(prepareBinding(target,now),target,now),leader=acquireWriteLeader(verified.control,null,now),capture=activateCapture(verified.control,leader,null,now);
 const binding={...verified.control,writeLeaderEpoch:leader.epoch,captureEpoch:capture.epoch};
 const activeSend=markSendUncertain(persistSendIntent(markSendReady(createSendTransaction({sessionId,generation,attemptId:sessionId+':a:1',effectId:'4'.repeat(64),challenge:'5'.repeat(64),purpose:'PROMPT',payloadUtf8Bytes:4},binding,leader,capture,now)),now),'SEND_UNCERTAIN');
 const expected=await store.commit(0,{binding,leader,capture,activeSend},now);
 let stops=0,observations=0,live={...target};let onStop:undefined|(()=>Promise<{status:'OFF'}>),onObserve:undefined|((n:number)=>void);
 const forbidden=async():Promise<never>=>{throw Error('UNEXPECTED_CONTENT_MUTATION');};
 const driver:BrowserContentDriverV1={stagePrompt:forbidden,startCapture:forbidden,preflightSend:forbidden,clickSend:forbidden,stopCapture:async(tabId)=>{assert.equal(tabId,target.tabId);stops++;return await (onStop?.()??Promise.resolve({status:'OFF' as const}));}};
 const reader={observe:async()=>{onObserve?.(++observations);return {...live};}};
 const runtime=new BrowserAuthorityRuntimeV1(store,reader,driver);
 return {storage,store,expected,runtime,reader,driver,counts:()=>({stops,observations}),setLive:(value:BrowserTargetObservationV1)=>{live=value;},setStop:(value:typeof onStop)=>{onStop=value;},setObserve:(value:typeof onObserve)=>{onObserve=value;}};
}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_STOP_CAPTURE '+name);}catch(error){failed++;console.error('FAIL V3_STOP_CAPTURE '+name+': '+String(error instanceof Error?error.stack:error));}}
await test('real_off_precedes_durable_release_and_preserves_uncertain_send',async()=>{
 const h=await fixture();let off=false;h.setStop(async()=>{off=true;assert.equal((await h.store.load())?.capture?.status,'ACTIVE');return {status:'OFF'};});
 h.storage.beforeSet=()=>{assert.equal(off,true);};const result=await stop(h.runtime,h.expected);
 assert.equal(h.counts().stops,1);assert.equal(result.capture?.status,'LOST');assert.equal(result.leader?.status,'RELEASED');
 assert.deepEqual(result.activeSend,h.expected.activeSend);assert.deepEqual(result.binding,h.expected.binding);assert.equal(result.capture?.epoch,h.expected.capture?.epoch);assert.equal(result.leader?.epoch,h.expected.leader?.epoch);
 assert.deepEqual(await h.store.load(),result);
});
await test('fresh_runtime_repeats_real_off_without_rewriting_stopped_history',async()=>{
 const h=await fixture(),first=await stop(h.runtime,h.expected),reloaded=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(h.storage),h.reader,h.driver);
 const second=await stop(reloaded,first);assert.equal(h.counts().stops,2);assert.deepEqual(second,first);
});
await test('wrong_scope_never_calls_content_or_rewrites_authority',async()=>{
 const h=await fixture();await assert.rejects(stop(h.runtime,h.expected,{...scope,sessionId:'exta-'+'6'.repeat(32)}),/RBRIDGE_SCOPE_STOP_SCOPE_MISMATCH/);await assert.rejects(stop(h.runtime,h.expected,{...scope,generation:'66666666-6666-4666-8666-666666666666'}),/RBRIDGE_SCOPE_STOP_SCOPE_MISMATCH/);assert.equal(h.counts().stops,0);assert.deepEqual(await h.store.load(),h.expected);
});
await test('stale_revision_never_calls_content',async()=>{
 const h=await fixture();await h.store.commit(h.expected.revision,h.expected);await assert.rejects(stop(h.runtime,h.expected),/RBRIDGE_BROWSER_AUTHORITY_CHANGED/);assert.equal(h.counts().stops,0);
});
await test('stale_live_target_before_off_never_calls_content',async()=>{
 const h=await fixture();h.setLive({...target,conversationId:'other-conversation'});await assert.rejects(stop(h.runtime,h.expected),/BROWSER_BINDING_STALE/);assert.equal(h.counts().stops,0);assert.deepEqual(await h.store.load(),h.expected);
});
await test('navigation_during_off_prevents_release',async()=>{
 const h=await fixture();h.setStop(async()=>{h.setLive({...target,tabId:3});return {status:'OFF'};});await assert.rejects(stop(h.runtime,h.expected),/BROWSER_BINDING_STALE/);assert.equal(h.counts().stops,1);assert.deepEqual(await h.store.load(),h.expected);
});
await test('concurrent_authority_write_during_off_is_not_overwritten',async()=>{
 const h=await fixture();let changed:BrowserAuthoritySnapshotV1|undefined;h.setStop(async()=>{changed=await h.store.commit(h.expected.revision,h.expected);return {status:'OFF'};});
 await assert.rejects(stop(h.runtime,h.expected),/RBRIDGE_BROWSER_AUTHORITY_CHANGED/);assert.deepEqual(await h.store.load(),changed);assert.equal(changed?.capture?.status,'ACTIVE');
});
await test('content_channel_failure_never_releases_durable_authority',async()=>{
 const h=await fixture();h.setStop(async()=>{throw Error('OFF_UNCERTAIN');});await assert.rejects(stop(h.runtime,h.expected),/OFF_UNCERTAIN/);assert.deepEqual(await h.store.load(),h.expected);
});
await test('malformed_content_off_reply_never_releases_authority',async()=>{
 const h=await fixture();h.setStop(async()=>({status:'ACTIVE'} as unknown as {status:'OFF'}));await assert.rejects(stop(h.runtime,h.expected),/RBRIDGE_CAPTURE_RUNTIME_NOT_OFF/);assert.deepEqual(await h.store.load(),h.expected);
});
await test('storage_failure_after_off_does_not_report_release',async()=>{
 const h=await fixture();h.storage.beforeSet=()=>{throw Error('DISK_FAILED');};await assert.rejects(stop(h.runtime,h.expected),/RBRIDGE_AUTHORITY_STORE_WRITE_UNCERTAIN/);h.storage.beforeSet=undefined;assert.equal(h.counts().stops,1);assert.deepEqual(await h.store.load(),h.expected);
});
await test('postwrite_readback_failure_does_not_report_success',async()=>{
 const h=await fixture();h.storage.afterSet=()=>{h.storage.beforeGet=()=>{throw Error('READBACK_FAILED');};};
 await assert.rejects(stop(h.runtime,h.expected),/READBACK_FAILED/);h.storage.beforeGet=undefined;assert.equal((await h.store.load())?.leader?.status,'RELEASED');
});
await test('missing_controls_reject_before_content_off',async()=>{
 for(const missing of ['binding','leader','capture']as const){const h=await fixture();const state=missing==='binding'?{binding:null,leader:null,capture:null,activeSend:null}:missing==='leader'?{...h.expected,leader:null,capture:null,activeSend:null}:{...h.expected,capture:null,activeSend:null};const basis=await h.store.commit(h.expected.revision,state);await assert.rejects(stop(h.runtime,basis),/RBRIDGE_SCOPE_STOP_AUTHORITY_REQUIRED/);assert.equal(h.counts().stops,0);assert.deepEqual(await h.store.load(),basis);}
});
await test('caller_snapshot_mutation_cannot_change_private_stop_basis',async()=>{
 const h=await fixture(),input=structuredClone(h.expected);h.setStop(async()=>{input.binding!.tabId=99;input.activeSend!.state='STOPPED';return {status:'OFF'};});
 const result=await stop(h.runtime,input);assert.deepEqual(result.binding,h.expected.binding);assert.deepEqual(result.activeSend,h.expected.activeSend);
});
await test('navigation_after_commit_keeps_release_but_returns_no_proof',async()=>{
 const h=await fixture();h.storage.afterSet=()=>h.setLive({...target,conversationId:'other-conversation'});await assert.rejects(stop(h.runtime,h.expected),/BROWSER_BINDING_STALE/);const result=await h.store.load();assert.equal(result?.leader?.status,'RELEASED');assert.deepEqual(result?.activeSend,h.expected.activeSend);
});
await test('failed_concurrent_mutation_during_off_invalidates_stop_admission',async()=>{
 const h=await fixture();h.setStop(async()=>{h.storage.beforeSet=()=>{throw Error('OTHER_WRITE_FAILED');};await assert.rejects(h.store.commit(h.expected.revision,h.expected),/RBRIDGE_AUTHORITY_STORE_WRITE_UNCERTAIN/);h.storage.beforeSet=undefined;return {status:'OFF'};});
 await assert.rejects(stop(h.runtime,h.expected),/RBRIDGE_BROWSER_AUTHORITY_CHANGED/);assert.equal(h.counts().stops,1);assert.deepEqual(await h.store.load(),h.expected);
});
console.log(JSON.stringify({suite:'W1_V3_STOP_CAPTURE',passed,failed,scope:'SYNTHETIC_CONTENT_AND_STORAGE',ownerWindows:'NOT_RUN',actualBrowserSends:0}));if(failed)process.exitCode=1;
