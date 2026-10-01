import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1} from '../src/extension/browserAuthorityRuntime.js';
import {RbridgeEffectStoreV1} from '../src/extension/rbridgeEffectStore.js';
import {RbridgeEffectDispatcherV1} from '../src/extension/rbridgeEffectDispatcher.js';
import {BrowserEffectExecutorV3} from '../src/extension/rbridgeEffectExecutor.js';
import {ChatgptDeliveryAdapterV3,type DeliverySurfaceV3} from '../src/browser/chatgptDeliveryAdapter.js';
import {ChatgptRolloverAdapterV3,type ChatgptRolloverDriverV3} from '../src/browser/chatgptRolloverAdapter.js';
import {canonicalDigest,sha256Hex,type CocwinRbridgeEffectRequestV1,type ExactBrowserTargetV1,type RbridgeChatEffectCommandV1} from '../src/domain/rbridgeEffectProtocol.js';
import type {BrowserTargetObservationV1} from '../src/domain/rbridgeChatCore.js';

const fixture=JSON.parse(await readFile(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8'));
const commands=(fixture.vectors as {command:RbridgeChatEffectCommandV1}[]).map(vector=>vector.command);
const at='2026-10-01T14:00:00.000Z';
class MemoryStorage implements ChromeStorageAreaV1{
  data:Record<string,unknown>={};failDelivery=false;corruptReadback=false;
  async get(key:string){const row=key in this.data?{[key]:structuredClone(this.data[key])}:{};if(this.corruptReadback&&key.startsWith('rbridgeDeliveryV3:')&&key in row)return {[key]:{invalid:true}};return row;}
  async set(items:Record<string,unknown>){if(this.failDelivery&&Object.keys(items).some(key=>key.startsWith('rbridgeDeliveryV3:')))throw Error('quota');Object.assign(this.data,structuredClone(items));}
}
async function command(index:number,patch:Partial<ExactBrowserTargetV1>={},ordinal?:number):Promise<RbridgeChatEffectCommandV1>{
  const original=structuredClone(commands[index]!),r=original.request;
  r.payload.target={...r.payload.target,...patch};if(ordinal!==undefined)r.effectOrdinal=ordinal;
  r.effectId=await sha256Hex([r.sessionId,r.generation,r.attemptId,r.effectKind,String(r.effectOrdinal)].join('\0'));
  const {requestDigest:_old,...requestBody}=r;void _old;original.request={...requestBody,requestDigest:await canonicalDigest(requestBody)} as CocwinRbridgeEffectRequestV1;
  original.commandId='effects:'+String(index)+':'+String(ordinal??r.effectOrdinal)+':'+await canonicalDigest(patch);
  const {commandSha256:_hash,...body}=original;void _hash;return {...body,commandSha256:await canonicalDigest(body)};
}
function observation(request:CocwinRbridgeEffectRequestV1):BrowserTargetObservationV1{
  const {canonicalProjectId:_canonical,...target}=request.payload.target;
  void _canonical;
  return {...target,sessionId:request.sessionId,generation:request.generation,ownerSessionId:request.sessionId};
}
function url(t:ExactBrowserTargetV1){return t.origin+'/g/'+t.projectId+'/c/'+t.conversationId;}
async function setup(options:{delivery?:boolean;click?:'CLICKED'|'FAILED_BEFORE_CLICK'|'UNCERTAIN';rollover?:boolean}={}){
  const storage=new MemoryStorage(),bind=await command(0),target=bind.request.payload.target;
  let live=observation(bind.request),clicks=0,navigations=0,quiescent=true,surface:DeliverySurfaceV3={documentId:'document-original',documentUrl:url(target),observedAt:at,turns:[]};
  let afterClick:(()=>Promise<void>)|null=null,beforeClick:(()=>Promise<void>)|null=null,nextPatch:Partial<ExactBrowserTargetV1>={};
  const content:BrowserContentDriverV1={
    stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),
    startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),
    preflightSend:async()=>{if(beforeClick){const hook=beforeClick;beforeClick=null;await hook();}return {status:'FOUND'};},
    clickSend:async(...args:unknown[])=>{
      const guard=args[1] as {text:string}|undefined;
      assert.ok(guard,'V3 click must carry document, baseline and original text');
      const current=await runtime.state();assert.equal(current?.activeSend?.state,'SEND_INTENT');
      assert.ok(storage.data.rbridgeEffectLedgerV1,'ledger must exist before click');
      assert.ok(Object.keys(storage.data).some(key=>key.startsWith('rbridgeDeliveryV3:')),'baseline must be durable before click');
      if(options.click==='FAILED_BEFORE_CLICK')return {outcome:'FAILED_BEFORE_CLICK',reason:'RBRIDGE_SEND_BUTTON_NOT_FOUND'};
      clicks++;if(options.delivery)surface={...surface,turns:[...surface.turns,{userTurnId:'new-user-turn',textSha256:await sha256Hex(guard!.text)}]};
      if(afterClick)await afterClick();
      return options.click==='UNCERTAIN'?{outcome:'UNCERTAIN',reason:'SEND_UNCERTAIN'}:{outcome:'CLICKED'};
    },
  };
  const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),{observe:async()=>structuredClone(live)},content);
  const effects=new RbridgeEffectStoreV1(storage),delivery=new ChatgptDeliveryAdapterV3(storage,{scan:async()=>structuredClone(surface)});
  const driver:ChatgptRolloverDriverV3={
    available:()=>options.rollover===true,quiescent:async()=>quiescent,
    createNext:async(previous:ExactBrowserTargetV1,next:number)=>{navigations++;const target={...previous,conversationId:'conv-next',conversationGeneration:next,...nextPatch};live={...live,...target};surface={...surface,documentUrl:url(target),documentId:'document-next',turns:[]};return target;},
  };
  const rollover=new ChatgptRolloverAdapterV3(runtime,driver),executor=new BrowserEffectExecutorV3(runtime,effects,delivery,rollover);
  const dispatcher=new RbridgeEffectDispatcherV1(effects,request=>executor.executeBrowserEffect(request));
  return {storage,runtime,effects,delivery,executor,dispatcher,bind,target,clicks:()=>clicks,navigations:()=>navigations,
    surface:(next:DeliverySurfaceV3)=>{surface=next;},getSurface:()=>structuredClone(surface),live:(next:BrowserTargetObservationV1)=>{live=next;},
    afterClick:(hook:()=>Promise<void>)=>{afterClick=hook;},beforeClick:(hook:()=>Promise<void>)=>{beforeClick=hook;},
    quiescence:(value:boolean)=>{quiescent=value;},nextTarget:(patch:Partial<ExactBrowserTargetV1>)=>{nextPatch=patch;}};
}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_EFFECTS '+name);}catch(error){failed++;console.error('FAIL V3_EFFECTS '+name+': '+String(error));}}
await test('bind_emits_final_persisted_positive_epochs',async()=>{
  const h=await setup(),result=await h.dispatcher.dispatch(h.bind);assert.equal(result.state,'VERIFIED');
  const receipt=result.receipt! as {writeLeaderEpoch:number;captureEpoch:number};assert.ok(receipt.writeLeaderEpoch>0);assert.ok(receipt.captureEpoch>0);
  assert.equal(h.clicks(),0);assert.equal(h.navigations(),0);
});
await test('click_is_not_delivery_verification',async()=>{
  const h=await setup();await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(1));
  assert.equal(result.state,'UNCERTAIN');assert.equal(result.reason,'SEND_UNCERTAIN');assert.equal(h.clicks(),1);
  assert.notEqual((await h.runtime.state())?.activeSend?.state,'SENT_VERIFIED');
});
await test('new_exact_user_turn_is_durable_before_verified',async()=>{
  const h=await setup({delivery:true});await h.dispatcher.dispatch(h.bind);const send=await command(1),result=await h.dispatcher.dispatch(send);
  assert.equal(result.state,'VERIFIED');assert.equal((result.receipt as {transactionState:string}).transactionState,'SENT_VERIFIED');
  const row=h.storage.data['rbridgeDeliveryV3:'+send.request.effectId] as {observation:{userTurnId:string;textSha256:string}};
  assert.equal(row.observation.userTurnId,'new-user-turn');assert.equal(row.observation.textSha256,await sha256Hex((send.request.payload as {text:string}).text));
  assert.equal(h.clicks(),1);
  assert.deepEqual(await h.dispatcher.dispatch(send),result);assert.equal(h.clicks(),1);
});
await test('result_send_preserves_result_purpose',async()=>{
  const h=await setup({delivery:true});await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(2));
  assert.equal(result.state,'VERIFIED');assert.equal((result.receipt as {purpose:string}).purpose,'RESULT');
});
await test('known_preclick_failure_is_failed_safe',async()=>{
  const h=await setup({click:'FAILED_BEFORE_CLICK'});await h.dispatcher.dispatch(h.bind);
  const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'FAILED_SAFE');assert.equal(h.clicks(),0);
  assert.equal((result.receipt as {transactionState:string}).transactionState,'FAILED_BEFORE_CLICK');
});
await test('unknown_click_transport_does_not_retry',async()=>{
  const h=await setup({click:'UNCERTAIN'});await h.dispatcher.dispatch(h.bind);const send=await command(1),result=await h.dispatcher.dispatch(send);
  assert.equal(result.state,'UNCERTAIN');assert.equal(h.clicks(),1);assert.deepEqual(await h.dispatcher.dispatch(send),result);assert.equal(h.clicks(),1);
});
await test('historical_user_turn_is_not_delivery',async()=>{
  const h=await setup(),send=await command(1),text=(send.request.payload as {text:string}).text;
  h.surface({...h.getSurface(),turns:[{userTurnId:'historical-user-turn',textSha256:await sha256Hex(text)}]});
  await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(send);assert.equal(result.state,'UNCERTAIN');assert.equal(h.clicks(),1);
});
await test('different_text_or_multiple_new_turns_is_unavailable',async()=>{
  for(const turns of [[{userTurnId:'new-user-turn',textSha256:'0'.repeat(64)}],[{userTurnId:'new-user-turn',textSha256:'0'.repeat(64)},{userTurnId:'other-new',textSha256:'0'.repeat(64)}]]){
    const h=await setup();h.afterClick(async()=>{h.surface({...h.getSurface(),turns});});await h.dispatcher.dispatch(h.bind);
    const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'UNCERTAIN');assert.equal(h.clicks(),1);
  }
});
await test('same_url_reload_cannot_match_old_document_baseline',async()=>{
  const h=await setup({delivery:true});h.afterClick(async()=>h.surface({...h.getSurface(),documentId:'document-reloaded'}));
  await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'UNCERTAIN');
});
await test('request_must_match_every_bound_target_field_before_click',async()=>{
  const patches:Partial<ExactBrowserTargetV1>[]=[{tabId:21},{windowId:11},{browserInstanceId:'wrong-browser'},{browserProfileId:'wrong-profile'},
    {projectId:'g-p-'+'b'.repeat(32)+'-wrong',canonicalProjectId:'g-p-'+'b'.repeat(32)},{conversationId:'wrong-conversation'},{conversationGeneration:2}];
  for(const patch of patches){const h=await setup();await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(1,patch));assert.equal(result.state,'BLOCKED');assert.equal(h.clicks(),0);}
});
await test('delivery_storage_failure_or_corrupt_readback_denies_click',async()=>{
  for(const mode of ['failDelivery','corruptReadback'] as const){const h=await setup();await h.dispatcher.dispatch(h.bind);h.storage[mode]=true;
    const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'BLOCKED');assert.equal(h.clicks(),0);}
});
await test('observation_write_failure_after_click_is_uncertain',async()=>{
  const h=await setup({delivery:true});h.afterClick(async()=>{h.storage.failDelivery=true;});await h.dispatcher.dispatch(h.bind);
  const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'UNCERTAIN');assert.equal(h.clicks(),1);assert.notEqual((await h.runtime.state())?.activeSend?.state,'SENT_VERIFIED');
});
await test('authority_drift_after_click_denies_verified_receipt',async()=>{
  const h=await setup({delivery:true});h.afterClick(async()=>{const state=(await h.runtime.state())!;const store=new BrowserAuthorityStoreV1(h.storage);
    await store.commit(state.revision,{binding:state.binding,leader:state.leader,capture:state.capture,activeSend:{...state.activeSend!,challenge:'e'.repeat(64)}});});
  await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(1));assert.equal(result.state,'UNCERTAIN');assert.equal(h.clicks(),1);
});
await test('intent_survives_authority_changes_and_restart_never_clicks',async()=>{
  const h=await setup();await h.dispatcher.dispatch(h.bind);const send=await command(1);
  await h.runtime.stageSend({...send.request,...send.request.payload} as Parameters<BrowserAuthorityRuntimeV1['stageSend']>[0]);
  const intent=await h.runtime.persistSendIntentOnly();
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(h.storage),{observe:async()=>observation(h.bind.request)},
    {stagePrompt:async()=>{throw Error('must not stage');},startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>{throw Error('must not click');}});
  await assert.rejects(()=>restarted.executePersistedSend(),/RECONCILE_REQUIRED/);assert.deepEqual(await restarted.state(),intent);assert.equal(h.clicks(),0);
  await assert.rejects(()=>restarted.prepareAndVerifyBinding(observation(h.bind.request)),/SEND_ACTIVE_UNRESOLVED/);
});
await test('rollover_requires_same_project_and_quiescence',async()=>{
  const h=await setup({rollover:true});await h.dispatcher.dispatch(h.bind);const result=await h.dispatcher.dispatch(await command(3));
  assert.equal(result.state,'VERIFIED');const receipt=result.receipt as {bindingReceipt:{conversationGeneration:number;projectId:string;writeLeaderEpoch:number;captureEpoch:number}};
  assert.equal(receipt.bindingReceipt.conversationGeneration,h.target.conversationGeneration+1);assert.equal(receipt.bindingReceipt.projectId,h.target.projectId);
  assert.ok(receipt.bindingReceipt.writeLeaderEpoch>0);assert.ok(receipt.bindingReceipt.captureEpoch>0);assert.equal(h.navigations(),1);
});
await test('unsupported_or_nonquiescent_rollover_blocks_before_navigation',async()=>{
  for(const supported of [false,true]){const h=await setup({rollover:supported});await h.dispatcher.dispatch(h.bind);h.quiescence(false);
    const result=await h.dispatcher.dispatch(await command(3));assert.equal(result.state,'BLOCKED');assert.equal(h.navigations(),0);}
});
await test('wrong_successor_project_or_url_change_alone_never_verifies',async()=>{
  for(const patch of [{projectId:'g-p-'+'b'.repeat(32)+'-wrong',canonicalProjectId:'g-p-'+'b'.repeat(32)},{conversationId:'conv-123'},{conversationGeneration:1}]){
    const h=await setup({rollover:true});await h.dispatcher.dispatch(h.bind);h.nextTarget(patch);
    const result=await h.dispatcher.dispatch(await command(3));assert.equal(result.state,'UNCERTAIN');assert.equal(h.navigations(),1);
  }
});
await test('pending_send_denies_rollover_and_binding',async()=>{
  const h=await setup({rollover:true});await h.dispatcher.dispatch(h.bind);await h.dispatcher.dispatch(await command(1));
  const rollover=await command(3);await assert.rejects(()=>h.dispatcher.dispatch(rollover),/ACTIVE_UNRESOLVED/);assert.equal(h.navigations(),0);
  await assert.rejects(()=>h.runtime.prepareAndVerifyBinding(observation(h.bind.request)),/SEND_ACTIVE_UNRESOLVED/);
});
await test('generation_overflow_rejected_before_any_navigation',async()=>{
  const h=await setup({rollover:true});await h.dispatcher.dispatch(h.bind);const c=await command(3,{conversationGeneration:2147483647});
  (c.request.payload as {nextConversationGeneration:number}).nextConversationGeneration=2147483648;
  const {requestDigest:_old,...body}=c.request;void _old;c.request={...body,requestDigest:await canonicalDigest(body)} as CocwinRbridgeEffectRequestV1;
  const {commandSha256:_hash,...commandBody}=c;void _hash;const invalid={...commandBody,commandSha256:await canonicalDigest(commandBody)};
  await assert.rejects(()=>h.dispatcher.dispatch(invalid),/RBRIDGE_V3/);assert.equal(h.navigations(),0);
});
await test('unreserved_executor_request_has_no_browser_effect',async()=>{
  const h=await setup();const result=await h.executor.executeBrowserEffect((await command(1)).request);assert.equal(result.state,'BLOCKED');assert.equal(h.clicks(),0);
});
console.log(JSON.stringify({suite:'W1_V3_BROWSER_EFFECTS',passed,failed}));if(failed)process.exitCode=1;
