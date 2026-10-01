import assert from 'node:assert/strict';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1,type BrowserAuthoritySnapshotV1} from '../src/extension/browserAuthorityStore.js';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1,type BrowserLiveTargetReaderV1} from '../src/extension/browserAuthorityRuntime.js';
import type {BrowserTargetObservationV1,RbridgeChatBindingReceiptV1} from '../src/domain/rbridgeChatCore.js';

const session='exta-'+'e'.repeat(32),generation='123e4567-e89b-42d3-a456-426614174000',at='2026-10-01T11:00:00.000Z';
const target:BrowserTargetObservationV1={sessionId:session,generation,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:10,tabId:20,origin:'https://chatgpt.com',projectId:'g-p-'+'a'.repeat(32)+'-05-cocwin',conversationId:'6a819823-07fc-83eb-b324-ddf6f474ea29',conversationGeneration:1,ownerSessionId:session};
class MemoryStorage implements ChromeStorageAreaV1{
  data:Record<string,unknown>={};failWrites=false;
  async get(key:string):Promise<Record<string,unknown>>{return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
  async set(items:Record<string,unknown>):Promise<void>{if(this.failWrites)throw Error('simulated quota');Object.assign(this.data,structuredClone(items));}
}
type FinalRuntime=BrowserAuthorityRuntimeV1 & {finalizeBindingReceipt?:(now?:Date)=>Promise<{snapshot:BrowserAuthoritySnapshotV1;receipt:RbridgeChatBindingReceiptV1}>};
async function finalize(runtime:BrowserAuthorityRuntimeV1){
  const extended=runtime as FinalRuntime;
  assert.equal(typeof extended.finalizeBindingReceipt,'function','FINAL_BINDING_RECEIPT_METHOD_MISSING');
  return await extended.finalizeBindingReceipt!(new Date(at));
}
async function setup(){
  const storage=new MemoryStorage();let live=structuredClone(target),clicks=0,captureConfirmed=true;
  const reader:BrowserLiveTargetReaderV1={observe:async()=>structuredClone(live)};
  const content:BrowserContentDriverV1={
    stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).length}),
    startCapture:async()=>{if(!captureConfirmed)throw Error('RBRIDGE_CAPTURE_RUNTIME_NOT_ACTIVE');return {status:'ACTIVE'};},
    stopCapture:async()=>({status:'OFF'}),preflightSend:async()=>({status:'FOUND'}),
    clickSend:async()=>{clicks++;return {outcome:'CLICKED'};},
  };
  const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),reader,content);
  await runtime.prepareAndVerifyBinding(target,new Date(at));
  return {storage,runtime,reader,content,changeLive:(next:BrowserTargetObservationV1)=>{live=next;},denyCapture:()=>{captureConfirmed=false;},clicks:()=>clicks};
}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_BINDING '+name);}catch(error){failed++;console.error('FAIL V3_BINDING '+name+': '+String(error));}}
await test('final_binding_receipt_has_persisted_positive_epochs',async()=>{
  const h=await setup();await h.runtime.acquireLeader(new Date(at));await h.runtime.activateCapture(new Date(at));
  const final=await finalize(h.runtime);
  assert.ok(final.receipt.writeLeaderEpoch>0);assert.ok(final.receipt.captureEpoch>0);
  assert.equal(final.receipt.writeLeaderEpoch,final.snapshot.leader?.epoch);
  assert.equal(final.receipt.captureEpoch,final.snapshot.capture?.epoch);
  assert.equal(final.snapshot.binding?.writeLeaderEpoch,final.receipt.writeLeaderEpoch);
  assert.equal(final.snapshot.binding?.captureEpoch,final.receipt.captureEpoch);
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(h.storage),h.reader,h.content);
  assert.deepEqual(await restarted.state(),final.snapshot);assert.equal(h.clicks(),0);
});
await test('final_binding_receipt_requires_confirmed_capture',async()=>{
  const h=await setup();await h.runtime.acquireLeader(new Date(at));
  await assert.rejects(()=>finalize(h.runtime),/BROWSER_AUTHORITY_NOT_READY/);
  await h.runtime.activateCapture(new Date(at));const before=await h.runtime.state();h.denyCapture();
  await assert.rejects(()=>finalize(h.runtime),/CAPTURE_RUNTIME_NOT_ACTIVE/);
  assert.deepEqual(await h.runtime.state(),before);assert.equal(h.clicks(),0);
});
await test('final_binding_receipt_reobserves_every_exact_target_field',async()=>{
  const variants:Partial<BrowserTargetObservationV1>[]=[
    {tabId:21},{windowId:11},{browserInstanceId:'other-browser'},{browserProfileId:'other-profile'},
    {projectId:'g-p-'+'b'.repeat(32)+'-other'},{conversationId:'other-conversation'},{conversationGeneration:2},
    {generation:'123e4567-e89b-42d3-a456-426614174001'},{sessionId:'exta-'+'d'.repeat(32),ownerSessionId:'exta-'+'d'.repeat(32)},
  ];
  for(const variant of variants){
    const h=await setup();await h.runtime.acquireLeader(new Date(at));await h.runtime.activateCapture(new Date(at));
    const before=await h.runtime.state();h.changeLive({...target,...variant});
    await assert.rejects(()=>finalize(h.runtime),/BROWSER_BINDING_STALE/);
    assert.deepEqual(await h.runtime.state(),before);assert.equal(h.clicks(),0);
  }
});
await test('final_binding_receipt_cannot_supersede_pending_send_intent',async()=>{
  const h=await setup();await h.runtime.acquireLeader(new Date(at));await h.runtime.activateCapture(new Date(at));
  await h.runtime.stageSend({sessionId:session,generation,attemptId:session+':a:1',effectId:'f'.repeat(64),challenge:'c'.repeat(64),purpose:'PROMPT',text:'binding receipt checkpoint'},new Date(at));
  const before=await h.runtime.persistSendIntentOnly(new Date(at));
  await assert.rejects(()=>finalize(h.runtime),/SEND_ACTIVE_UNRESOLVED/);
  assert.deepEqual(await h.runtime.state(),before);assert.equal(h.clicks(),0);
});
await test('final_binding_receipt_is_not_returned_after_storage_failure',async()=>{
  const h=await setup();await h.runtime.acquireLeader(new Date(at));await h.runtime.activateCapture(new Date(at));
  const before=await h.runtime.state();h.storage.failWrites=true;
  await assert.rejects(()=>finalize(h.runtime),/WRITE_UNCERTAIN/);h.storage.failWrites=false;
  assert.deepEqual(await h.runtime.state(),before);assert.equal(h.clicks(),0);
});
await test('click_is_not_delivery_verification',async()=>{
  const h=await setup();await h.runtime.acquireLeader(new Date(at));await h.runtime.activateCapture(new Date(at));
  await h.runtime.stageSend({sessionId:session,generation,attemptId:session+':a:1',effectId:'f'.repeat(64),challenge:'c'.repeat(64),purpose:'PROMPT',text:'no delivery proof'},new Date(at));
  const clicked=await h.runtime.sendOnce(new Date(at));
  assert.equal(clicked.activeSend?.state,'CLICKED_UNVERIFIED');assert.equal(clicked.activeSend?.sentVerifiedAt,null);assert.equal(h.clicks(),1);
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(h.storage),h.reader,h.content);
  await assert.rejects(()=>restarted.sendOnce(new Date(at)),/SEND_NOT_READY/);assert.equal(h.clicks(),1);
});
console.log(JSON.stringify({schema:'RBRIDGE_V3_BINDING_FOUNDATION_QUALIFICATION_V1',status:failed?'FAIL':'PASS',passed,failed,scope:'TASK5_BINDING_FOUNDATION_ONLY'}));if(failed)process.exitCode=1;
