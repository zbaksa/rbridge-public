import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1} from '../src/extension/browserAuthorityRuntime.js';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {RbridgeEffectStoreV1} from '../src/extension/rbridgeEffectStore.js';
import {RbridgeCaptureEgressV3,captureTokenV3,type ContentCaptureNotificationV3,type ChromeCaptureSenderV3} from '../src/extension/rbridgeCaptureEgress.js';
import {DurableCaptureNotifierV3} from '../src/extension/contentMessageBridge.js';
import {canonicalJson,type RbridgeChatEffectCommandV1} from '../src/domain/rbridgeEffectProtocol.js';
import type {BrowserTargetObservationV1} from '../src/domain/rbridgeChatCore.js';
const fixture=JSON.parse(await readFile(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8'));
const send=fixture.vectors[1].command as RbridgeChatEffectCommandV1;
const extensionId='ebibbijpegoankenmggdnehpoadcophk',t=send.request.payload.target;
const sender:ChromeCaptureSenderV3={id:extensionId,tabId:t.tabId,frameId:0,url:t.origin+'/g/'+t.projectId+'/c/'+t.conversationId};
class MemoryStorage implements ChromeStorageAreaV1{
  data:Record<string,unknown>={};failWrites=false;failAfterWrite=false;order:string[]=[];
  async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
  async set(items:Record<string,unknown>){const outbox='rbridgeCaptureOutboxV3' in items;if(outbox&&this.failWrites)throw Error('quota');Object.assign(this.data,structuredClone(items));if(outbox){this.order.push('PERSIST_EVENT');if(this.failAfterWrite)throw Error('uncertain after write');}}
}
async function setup(maxMessageBytes=65536){
  const storage=new MemoryStorage();const {canonicalProjectId:omitted,...target}=t;void omitted;
  let live:BrowserTargetObservationV1={...target,sessionId:send.request.sessionId,generation:send.request.generation,ownerSessionId:send.request.sessionId};
  const content:BrowserContentDriverV1={stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>({outcome:'CLICKED'})};
  const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),{observe:async()=>structuredClone(live)},content);
  await runtime.prepareAndVerifyBinding(live);await runtime.acquireLeader();await runtime.activateCapture();await runtime.finalizeBindingReceipt();
  const effects=new RbridgeEffectStoreV1(storage);await effects.reserve(send);
  const payload=send.request.payload as {text:string;challenge:string;purpose:'PROMPT'};
  await runtime.stageSend({...send.request,...payload});await runtime.persistSendIntentOnly();await runtime.executePersistedSend();await runtime.markDeliveryVerified();
  const state=(await runtime.state())!,token=captureTokenV3(send.request,state.capture!.epoch);let portFails=false;
  const options={storage,runtime,effects,extensionId,browserInstanceId:t.browserInstanceId,browserProfileId:t.browserProfileId,ownerAppId:'cocwin',maxMessageBytes,initialHistory:[],publish:async()=>{storage.order.push('NATIVE_FORWARD');if(portFails)throw Error('disconnected');}};
  const egress=new RbridgeCaptureEgressV3(options);
  const notification=(markdown='proza Ž🙂\r\n```json\r\n{"x":1}\r\n```',assistantTurnId='assistant-new'):ContentCaptureNotificationV3=>({schema:'RBRIDGE_CONTENT_CAPTURE_V3',captureToken:token,assistantTurnId,observation:{kind:'CAPTURED',assistantTurnId,markdown}});
  return {storage,runtime,effects,egress,options,token,notification,live:(value:BrowserTargetObservationV1)=>{live=value;},currentLive:()=>structuredClone(live),portFailure:()=>{portFails=true;}};
}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_CAPTURE '+name);}catch(error){failed++;console.error('FAIL V3_CAPTURE '+name+': '+String(error));}}
await test('capture_retries_until_durable_ack_without_second_event',async()=>{
  const h=await setup(),n=h.notification();let loseAck=true;
  const notifier=new DurableCaptureNotifierV3(async(value:unknown)=>{const ack=await h.egress.accept(value,sender);if(loseAck){loseAck=false;throw Error('lost reply');}return ack;});
  await assert.rejects(()=>notifier.notify(n),/lost reply/);assert.equal(notifier.hasAcknowledged(n),false);
  const first=await h.egress.events();assert.equal(first.length,1);assert.equal(h.storage.order[0],'PERSIST_EVENT');
  const ack=await notifier.notify(n);assert.equal(ack.durable,true);assert.equal(notifier.hasAcknowledged(n),true);
  assert.equal((await h.egress.events()).length,1);assert.equal(ack.eventSha256,first[0]!.eventSha256);
});
await test('persisted_full_turn_preserves_bytes_and_bounded_receipt_identity',async()=>{
  const h=await setup(),n=h.notification(fixture.capturedEvent.payload.assistantTurnUtf8,'a'.repeat(256));await h.egress.accept(n,sender);
  const event=(await h.egress.events())[0]!,receipt=event.payload.captureReceipt as {responseUtf8Bytes:number;receiptId:string;effectId:string;challenge:string};
  assert.equal(event.payload.assistantTurnUtf8,fixture.capturedEvent.payload.assistantTurnUtf8);assert.equal(receipt.responseUtf8Bytes,fixture.markdownUtf8Bytes);
  assert.ok(new TextEncoder().encode(receipt.receiptId).byteLength<=256);assert.equal(receipt.effectId,send.request.effectId);assert.equal(receipt.challenge,(send.request.payload as {challenge:string}).challenge);
});
await test('escaped_turn_and_rejection_floor',async()=>{
  for(const [text,reason] of [['\u0001'.repeat(16384),'OUTPUT_BUDGET_EXCEEDED'],['x'.repeat(16385),'MACHINE_RESPONSE_TOO_LARGE']] as const){
    const h=await setup(),ack=await h.egress.accept(h.notification(text),sender),event=(await h.egress.events())[0]!;
    assert.equal(ack.durable,true);assert.equal(event.eventType,'ASSISTANT_TURN_REJECTED_V2');assert.equal(event.payload.reason,reason);
    assert.ok(new TextEncoder().encode(canonicalJson(event)).byteLength<=4096);
  }
});
await test('small_peer_budget_retains_untransmittable_rejection_locally',async()=>{
  const h=await setup(4096),n=h.notification('x'.repeat(16385),'a'.repeat(256));await h.egress.accept(n,sender);
  await h.egress.flush();assert.equal((await h.egress.events()).length,1);
  assert.ok(new TextEncoder().encode(canonicalJson((await h.egress.events())[0])).byteLength<=4096);
});
await test('wrong_sender_tab_frame_url_profile_or_live_target_produces_no_event',async()=>{
  for(const patch of [{id:'a'.repeat(32)},{tabId:21},{frameId:1},{url:sender.url.replace('conv-123','wrong')}]){
    const h=await setup();await assert.rejects(()=>h.egress.accept(h.notification(),{...sender,...patch}),/CAPTURE|BROWSER/);assert.equal((await h.egress.events()).length,0);
  }
  for(const patch of [{browserProfileId:'wrong-profile'},{browserInstanceId:'wrong-browser'},{conversationGeneration:2},{windowId:11}]){
    const h=await setup();h.live({...h.currentLive(),...patch});await assert.rejects(()=>h.egress.accept(h.notification(),sender),/CAPTURE|BROWSER/);assert.equal((await h.egress.events()).length,0);
  }
});
await test('forged_authority_fields_and_wrong_token_or_turn_are_rejected',async()=>{
  for(const change of ['sessionId','effectId','challenge','token','turn']){
    const h=await setup(),n=h.notification();const forged={...n,...(change==='token'?{captureToken:h.token+':wrong'}:change==='turn'?{assistantTurnId:'other-turn'}:{[change]:'forged'})};
    await assert.rejects(()=>h.egress.accept(forged,sender),/CAPTURE/);assert.equal((await h.egress.events()).length,0);
  }
});
await test('storage_failure_returns_no_ack_or_forward',async()=>{
  const h=await setup();h.storage.failWrites=true;await assert.rejects(()=>h.egress.accept(h.notification(),sender),/CAPTURE/);assert.deepEqual(h.storage.order,[]);
});
await test('postwrite_uncertainty_reconciles_after_worker_restart',async()=>{
  const h=await setup();h.storage.failAfterWrite=true;await assert.rejects(()=>h.egress.accept(h.notification(),sender),/CAPTURE/);h.storage.failAfterWrite=false;
  const wrapper:ChromeStorageAreaV1={get:key=>h.storage.get(key),set:items=>h.storage.set(items)};
  const reopened=new RbridgeCaptureEgressV3({...h.options,storage:wrapper});const ack=await reopened.accept(h.notification(),sender);assert.equal(ack.durable,true);assert.equal((await reopened.events()).length,1);
});
await test('port_outage_does_not_erase_durable_event_or_ack',async()=>{
  const h=await setup();h.portFailure();const ack=await h.egress.accept(h.notification(),sender);assert.equal(ack.durable,true);
  await h.egress.flush();assert.equal(h.storage.order[0],'PERSIST_EVENT');assert.ok(h.storage.order.includes('NATIVE_FORWARD'));assert.equal((await h.egress.events()).length,1);
});
await test('simultaneous_duplicate_and_distinct_observations_share_sequence_reservation',async()=>{
  const h=await setup(),a=h.notification('one','assistant-1'),b=h.notification('two','assistant-2');
  const [one,two,duplicate]=await Promise.all([h.egress.accept(a,sender),h.egress.accept(b,sender),h.egress.accept(a,sender)]);
  assert.deepEqual(one,duplicate);assert.notEqual(one.eventId,two.eventId);const events=await h.egress.events();assert.equal(events.length,2);assert.equal(events[0]!.sequence,1);assert.equal(events[1]!.sequence,2);assert.equal(events[1]!.previousEventSha256,events[0]!.eventSha256);
});
await test('notification_is_immutable_across_async_authority_reads',async()=>{
  const h=await setup(),n=h.notification('original');const pending=h.egress.accept(n,sender);if(n.observation.kind==='CAPTURED')n.observation.markdown='mutated';await pending;
  assert.equal((await h.egress.events())[0]!.payload.assistantTurnUtf8,'original');
});
await test('unavailable_site_acquisition_is_durable_capture_lost_without_capture_payload',async()=>{
  const h=await setup(),n={...h.notification(),observation:{kind:'UNAVAILABLE' as const,reason:'UI_PROTOCOL_CHANGED' as const}};
  await h.egress.accept(n,sender);const event=(await h.egress.events())[0]!;assert.equal(event.eventType,'CAPTURE_LOST');assert.deepEqual(event.payload,{reason:'UI_PROTOCOL_CHANGED'});assert.equal(event.effectId,send.request.effectId);
});
await test('token_binds_request_generation_effect_and_capture_epoch',async()=>{
  const h=await setup(),token=captureTokenV3(send.request,1);assert.notEqual(token,captureTokenV3(send.request,2));
  assert.notEqual(token,captureTokenV3(fixture.vectors[2].request,1));
  assert.match(token,/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/);await assert.rejects(()=>h.egress.accept({...h.notification(),captureToken:captureTokenV3(send.request,2)},sender),/CAPTURE/);
});
await test('corrupt_disappearing_or_cross_owner_outbox_fails_closed',async()=>{
  const h=await setup();await h.egress.accept(h.notification(),sender);h.storage.data.rbridgeCaptureOutboxV3={invalid:true};
  await assert.rejects(()=>h.egress.accept(h.notification('two','assistant-2'),sender),/CAPTURE/);
});
console.log(JSON.stringify({suite:'W1_V3_CAPTURE_EGRESS',passed,failed,liveAcceptance:'NOT_RUN'}));if(failed)process.exitCode=1;
