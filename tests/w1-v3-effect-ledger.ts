import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonicalDigest,type EffectExecutionV3,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,V3_CAPABILITIES} from '../src/domain/rbridgeEffectProtocol.js';
import type {ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {RbridgeEffectStoreV1} from '../src/extension/rbridgeEffectStore.js';
import {RbridgeEffectDispatcherV1} from '../src/extension/rbridgeEffectDispatcher.js';
import {ExtensionNativePortLinkV1,type ExtensionNativePortV1} from '../src/extension/nativePortServiceWorker.js';
import {parseRbridgeChatCommandV1} from '../src/domain/rbridgeChatCommand.js';
import type {RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';

const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!,send=fixture.vectors[1]!;
const outcome=(result:RbridgeChatEffectResultV1):EffectExecutionV3=>({state:result.state,receipt:structuredClone(result.receipt),reason:result.reason});
const safe:EffectExecutionV3={state:'FAILED_SAFE',receipt:null,reason:'TEST_FAILED_BEFORE_CLICK'};
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>):Promise<void>{try{await fn();passed++;console.log('PASS V3_LEDGER '+name);}catch(error){failed++;console.error('FAIL V3_LEDGER '+name+': '+String(error));}}
class MemoryStorage implements ChromeStorageAreaV1{
  data:Record<string,unknown>={};writes=0;fault:'NONE'|'QUOTA'|'POST_WRITE'|'READBACK'='NONE';
  async get(key:string):Promise<Record<string,unknown>>{
    if(this.fault==='READBACK'&&this.writes>0)throw Error('readback unavailable');
    return key in this.data?{[key]:structuredClone(this.data[key])}:{};
  }
  async set(items:Record<string,unknown>):Promise<void>{
    this.writes++;if(this.fault==='QUOTA')throw Error('QUOTA_BYTES');
    Object.assign(this.data,structuredClone(items));if(this.fault==='POST_WRITE')throw Error('acknowledgement lost');
  }
}
async function command(source=bind.command,id=source.commandId,action: 'EXECUTE'|'RECONCILE'=source.action):Promise<RbridgeChatEffectCommandV1>{
  const {commandSha256,...body}=structuredClone(source);void commandSha256;body.commandId=id;body.action=action;
  return {...body,commandSha256:await canonicalDigest(body)};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('READ_OR_COLLISION_BLOCKED_BY_MUTATION')),350);})]);}finally{clearTimeout(timer);}}

await test('restart_and_new_command_id_cannot_duplicate_effect',async()=>{
  const storage=new MemoryStorage();let clicks=0;
  const first=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1(storage),async()=>{clicks++;return outcome(send.result);});
  const originalResult=await first.dispatch(send.command);
  const restarted=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1(storage),async()=>{clicks++;return outcome(send.result);});
  assert.deepEqual(await restarted.dispatch(send.command),originalResult);
  const other=await command(send.command,'same-effect-new-id');
  const observed=await restarted.dispatch(other);
  assert.equal(observed.commandId,other.commandId);assert.equal(observed.commandSha256,other.commandSha256);
  assert.deepEqual(outcome(observed),outcome(originalResult));assert.equal(clicks,1);
  const altered=await command({...send.command,issuedAt:'2026-10-01T06:00:00.000Z'});
  await assert.rejects(()=>restarted.dispatch(altered),/REQUEST_ID_COLLISION/);assert.equal(clicks,1);
});
await test('delayed_crypto_preserves_arrival_order',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage),order:string[]=[];
  const first=await command(bind.command,'arrival-first'),second=await command(send.command,'arrival-second');
  const a=new RbridgeEffectDispatcherV1(store,async request=>{order.push(request.effectId);return safe;});
  const b=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1(storage),async request=>{order.push(request.effectId);return safe;});
  const gate=deferred(),entered=deferred(),digest=crypto.subtle.digest;let once=true;
  crypto.subtle.digest=async function(algorithm,data){if(once){once=false;entered.resolve();await gate.promise;}return digest.call(this,algorithm,data);};
  try{const pa=a.dispatch(first);await entered.promise;const pb=b.dispatch(second);await new Promise(r=>setTimeout(r,10));assert.deepEqual(order,[]);gate.resolve();await Promise.all([pa,pb]);assert.deepEqual(order,[first.request.effectId,second.request.effectId]);}
  finally{gate.resolve();crypto.subtle.digest=digest;}
});
await test('reconcile_remains_live_while_mutation_hangs',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage),gate=deferred(),entered=deferred();let clicks=0,laterMutationStarted=false;
  const dispatcher=new RbridgeEffectDispatcherV1(store,async request=>{if(request.effectId===send.command.request.effectId){clicks++;entered.resolve();await gate.promise;return outcome(send.result);}laterMutationStarted=true;return safe;});
  const reconcile=await command(send.command,'read-while-hung','RECONCILE'),later=await command(bind.command,'later-mutation');
  const original=dispatcher.dispatch(send.command);await entered.promise;
  const laterPromise=dispatcher.dispatch(later);
  try{
    const readWhileHung=await bounded(dispatcher.dispatch(reconcile));assert.equal(readWhileHung.state,'UNCERTAIN');
    assert.equal((await store.read(send.command.request.effectId,send.command.request.requestDigest))?.result,null);
    assert.equal(laterMutationStarted,false);assert.equal(clicks,1);
    await assert.rejects(()=>bounded(dispatcher.dispatch({...send.command,issuedAt:'2026-10-01T06:00:00.000Z'})),/REQUEST_ID_COLLISION/);
  }finally{gate.resolve();await original;await laterPromise;}
  assert.equal(laterMutationStarted,true);
});
await test('missing_reconcile_reserves_only_command_identity',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage);let calls=0;
  const dispatcher=new RbridgeEffectDispatcherV1(store,async()=>{calls++;return safe;});
  const reconcile=await command(bind.command,'missing-read','RECONCILE');
  const observed=await dispatcher.dispatch(reconcile);
  assert.equal(observed.state,'BLOCKED');assert.equal(observed.reason,'RBRIDGE_EFFECT_NOT_FOUND');
  assert.equal(await store.read(bind.command.request.effectId,bind.command.request.requestDigest),null);
  assert.deepEqual(await dispatcher.dispatch(reconcile),observed);assert.equal(calls,0);
  const fresh=await dispatcher.dispatch(bind.command);assert.equal(fresh.state,'FAILED_SAFE');assert.equal(calls,1);
});
for(const completed of [true,false]){
  await test((completed?'completed':'interrupted')+'_missing_read_cannot_authorize_or_corrupt_later_effect',async()=>{
    const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage);let calls=0;
    const dispatcher=new RbridgeEffectDispatcherV1(store,async()=>{calls++;return safe;});
    const read=await command(bind.command,'independent-missing-read','RECONCILE');
    const originalRead=completed?await dispatcher.dispatch(read):null;
    if(!completed)await store.reserve(read);
    const changed=structuredClone(bind.command);
    if(changed.request.effectKind!=='RBRIDGE_BIND')throw Error('fixture kind');
    changed.request.payload.target.conversationId='conv-authoritative';
    const {requestDigest,...body}=changed.request;void requestDigest;
    changed.request.requestDigest=await canonicalDigest(body);
    const execute=await command(changed,'authoritative-after-missing-read');
    const result=await dispatcher.dispatch(execute);
    assert.equal(result.state,'FAILED_SAFE');assert.equal(calls,1);
    const restartedStore=new RbridgeEffectStoreV1({get:key=>storage.get(key),set:items=>storage.set(items)});
    const restarted=new RbridgeEffectDispatcherV1(restartedStore,async()=>{calls++;return safe;});
    assert.deepEqual(await restarted.dispatch(execute),result);assert.equal(calls,1);
    assert.deepEqual((await restartedStore.read(execute.request.effectId,execute.request.requestDigest))?.request,execute.request);
    const saved=structuredClone(storage.data);
    if(completed)assert.deepEqual(await restarted.dispatch(read),originalRead);
    else await assert.rejects(()=>restarted.dispatch(read),/REQUEST_ID_COLLISION/);
    assert.deepEqual(storage.data,saved);
    assert.deepEqual(await restarted.dispatch(execute),result);assert.equal(calls,1);
  });
}
await test('pending_restart_never_reclicks_or_unblocks_later_effect',async()=>{
  const storage=new MemoryStorage(),first=new RbridgeEffectStoreV1(storage);assert.equal(await first.reserve(send.command),'NEW');
  let calls=0;const restartedStore=new RbridgeEffectStoreV1(storage),dispatcher=new RbridgeEffectDispatcherV1(restartedStore,async()=>{calls++;return safe;});
  const read=await dispatcher.dispatch(await command(send.command,'pending-read','RECONCILE'));assert.equal(read.state,'UNCERTAIN');
  assert.equal((await restartedStore.read(send.command.request.effectId,send.command.request.requestDigest))?.result,null);
  assert.equal((await dispatcher.dispatch(await command(send.command,'pending-new-execute'))).state,'UNCERTAIN');
  await assert.rejects(()=>dispatcher.dispatch(bind.command),/RBRIDGE_EFFECT_ACTIVE_UNRESOLVED/);assert.equal(calls,0);
});
await test('changed_request_with_same_effect_cannot_replace_original',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage);await store.reserve(send.command);
  const changed=structuredClone(send.command);if(changed.request.effectKind!=='RBRIDGE_SEND')throw Error('fixture kind');
  changed.request.payload.text+=' changed';const {requestDigest,...body}=changed.request;void requestDigest;changed.request.requestDigest=await canonicalDigest(body);
  const collision=await command(changed,'changed-request'),saved=structuredClone(storage.data);await assert.rejects(()=>store.reserve(collision),/REQUEST_ID_COLLISION/);
  assert.deepEqual(storage.data,saved);
  const preserved=await store.read(send.command.request.effectId,send.command.request.requestDigest);assert.deepEqual(preserved?.request,send.command.request);
});
for(const fault of ['QUOTA','POST_WRITE','READBACK'] as const){
  await test('storage_'+fault+'_denies_mutation',async()=>{
    const storage=new MemoryStorage();storage.fault=fault;let clicks=0;
    const dispatcher=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1(storage),async()=>{clicks++;return safe;});
    await assert.rejects(()=>dispatcher.dispatch(send.command),/RBRIDGE_EFFECT_(?:WRITE_UNCERTAIN|STORAGE_UNAVAILABLE)/);assert.equal(clicks,0);
    storage.fault='NONE';await assert.rejects(()=>dispatcher.dispatch(send.command),/RBRIDGE_EFFECT_STORAGE_UNAVAILABLE/);assert.equal(clicks,0);
    if(fault!=='QUOTA')assert.equal((await new RbridgeEffectStoreV1({get:key=>storage.get(key),set:items=>storage.set(items)}).read(send.command.request.effectId,send.command.request.requestDigest))?.outcome.state,'UNCERTAIN');
  });
}
await test('completed_result_write_failure_preserves_pending_effect',async()=>{
  const storage=new MemoryStorage();let clicks=0;
  const dispatcher=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1(storage),async()=>{clicks++;storage.fault='QUOTA';return outcome(send.result);});
  await assert.rejects(()=>dispatcher.dispatch(send.command),/RBRIDGE_EFFECT_WRITE_UNCERTAIN/);assert.equal(clicks,1);
  storage.fault='NONE';const restarted=new RbridgeEffectDispatcherV1(new RbridgeEffectStoreV1({get:key=>storage.get(key),set:items=>storage.set(items)}),async()=>{clicks++;return outcome(send.result);});
  assert.equal((await restarted.dispatch(send.command)).state,'UNCERTAIN');assert.equal(clicks,1);
});
await test('corrupt_and_disappearing_ledger_fail_closed',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage);await store.reserve(send.command);
  const key=Object.keys(storage.data)[0]!;const original=structuredClone(storage.data[key]);storage.data[key]={schema:'garbage'};
  await assert.rejects(()=>store.read(send.command.request.effectId,send.command.request.requestDigest),/RBRIDGE_EFFECT_(?:LEDGER_INVALID|STORAGE_UNAVAILABLE)/);
  storage.data[key]=original;await assert.rejects(()=>store.reserve(bind.command),/RBRIDGE_EFFECT_STORAGE_UNAVAILABLE/);
  const other=new MemoryStorage(),otherStore=new RbridgeEffectStoreV1(other);await otherStore.reserve(send.command);other.data={};
  await assert.rejects(()=>otherStore.reserve(bind.command),/RBRIDGE_EFFECT_(?:LEDGER_MISSING|STORAGE_UNAVAILABLE)/);
});
await test('caller_and_result_references_are_snapshotted',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage),gate=deferred(),entered=deferred();let received:unknown;
  const dispatcher=new RbridgeEffectDispatcherV1(store,async request=>{received=structuredClone(request);entered.resolve();await gate.promise;return outcome(send.result);});
  const input=structuredClone(send.command),promise=dispatcher.dispatch(input);
  if(input.request.effectKind!=='RBRIDGE_SEND')throw Error('fixture kind');input.request.payload.text='mutated after dispatch';input.commandId='mutated-id';
  await entered.promise;gate.resolve();const result=await promise;assert.deepEqual(received,send.command.request);
  result.reason='CALLER_MUTATED';assert.deepEqual(await dispatcher.dispatch(send.command),{...result,reason:null});
  const read=await store.read(send.command.request.effectId,send.command.request.requestDigest);if(read?.request.effectKind==='RBRIDGE_SEND')read.request.payload.text='mutated read';
  assert.deepEqual((await store.read(send.command.request.effectId,send.command.request.requestDigest))?.request,send.command.request);
});

await test('negotiated_v3_denies_v1_bind_leader_capture_before_legacy_hook',async()=>{
  const listeners:((value:unknown)=>void)[]=[],errors:string[]=[];let legacy=0;
  const port:ExtensionNativePortV1={postMessage:()=>{},disconnect:()=>{},onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener:()=>{}}};
  const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:'a'.repeat(40),maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES],browserInstanceId:'chrome-main',browserProfileId:'profile-main',nativeHostVersion:'1.0.0'};
  const link=new ExtensionNativePortLinkV1({connectNative:()=>port},hello,{onServerCommand:()=>{legacy++;},onProtocolError:error=>{errors.push(error.message);}});link.connect();
  const drain=()=>new Promise(r=>setTimeout(r,10));
  for(const action of ['BIND_TARGET','ACQUIRE_WRITE_LEADER','ACTIVATE_CAPTURE'] as const){
    listeners[0]!(hello);await drain();
    const payload=action==='BIND_TARGET'?{windowId:10,tabId:20,origin:'https://chatgpt.com',projectId:bind.command.request.payload.target.projectId,conversationId:'conv-123',conversationGeneration:1}:{};
    listeners[0]!(parseRbridgeChatCommandV1({schema:'RBRIDGE_CHAT_COMMAND_V1',requestDigest:'a'.repeat(64),issuedAt:'2026-10-01T05:00:00.000Z',commandId:'legacy-'+action,action,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation,attemptId:null,effectId:null,payload}));await drain();
  }
  assert.equal(legacy,0);assert.deepEqual(errors,Array(3).fill('RBRIDGE_V1_MUTATION_DISABLED'));
  listeners[0]!(hello);await drain();
  listeners[0]!(parseRbridgeChatCommandV1({schema:'RBRIDGE_CHAT_COMMAND_V1',requestDigest:'a'.repeat(64),issuedAt:'2026-10-01T05:00:00.000Z',commandId:'legacy-read',action:'READ_STATE',sessionId:bind.command.request.sessionId,generation:bind.command.request.generation,attemptId:null,effectId:null,payload:{}}));await drain();assert.equal(legacy,1);
});
await test('concurrent_storage_fault_denies_final_preclick_admission',async()=>{
  const storage=new MemoryStorage(),store=new RbridgeEffectStoreV1(storage),gate=deferred(),entered=deferred();let reads=0,clicks=0;
  const get=storage.get.bind(storage);
  storage.get=async key=>{const call=++reads,value=await get(key);if(call===3){entered.resolve();await gate.promise;}return value;};
  const dispatcher=new RbridgeEffectDispatcherV1(store,async()=>{clicks++;return safe;});
  const executing=dispatcher.dispatch(bind.command);await entered.promise;
  try{
    const key=Object.keys(storage.data)[0]!;storage.data[key]={schema:'corrupt'};
    await assert.rejects(()=>store.read(bind.command.request.effectId,bind.command.request.requestDigest),/RBRIDGE_EFFECT_(?:LEDGER_INVALID|STORAGE_UNAVAILABLE)/);
  }finally{gate.resolve();}
  await assert.rejects(()=>executing,/RBRIDGE_EFFECT_STORAGE_UNAVAILABLE/);assert.equal(clicks,0);
});
await test('same_port_v3_authority_cannot_downgrade_to_v1_mutation',async()=>{
  const ports:{messages:((value:unknown)=>void)[];disconnects:((value:void)=>void)[]}[]=[],errors:string[]=[];let legacy=0;
  const connectNative=():ExtensionNativePortV1=>{const state={messages:[] as ((value:unknown)=>void)[],disconnects:[] as ((value:void)=>void)[]};ports.push(state);return {postMessage:()=>{},disconnect:()=>{},onMessage:{addListener:fn=>state.messages.push(fn)},onDisconnect:{addListener:fn=>state.disconnects.push(fn)}};};
  const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:'a'.repeat(40),maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES],browserInstanceId:'chrome-main',browserProfileId:'profile-main',nativeHostVersion:'1.0.0'};
  const v1={...hello,protocolMinor:0,capabilities:V3_CAPABILITIES.slice(0,8)};
  const link=new ExtensionNativePortLinkV1({connectNative},hello,{onServerCommand:()=>{legacy++;},onProtocolError:error=>{errors.push(error.message);}});link.connect();
  const drain=()=>new Promise(r=>setTimeout(r,10));
  const mutate=parseRbridgeChatCommandV1({schema:'RBRIDGE_CHAT_COMMAND_V1',commandId:'downgraded-leader',action:'ACQUIRE_WRITE_LEADER',sessionId:bind.command.request.sessionId,generation:bind.command.request.generation,attemptId:null,effectId:null,requestDigest:'a'.repeat(64),issuedAt:'2026-10-01T05:00:00.000Z',payload:{}});
  ports[0]!.messages[0]!(hello);await drain();ports[0]!.messages[0]!(v1);await drain();ports[0]!.messages[0]!(mutate);await drain();
  assert.equal(legacy,0);assert.ok(errors.includes('RBRIDGE_V3_DOWNGRADE_DENIED'));
  link.disconnect();link.connect();ports[1]!.messages[0]!(v1);await drain();ports[1]!.messages[0]!(mutate);await drain();assert.equal(legacy,1);
  // A message from the old connection must not negotiate authority on the new port.
  ports[0]!.messages[0]!(hello);await drain();ports[1]!.messages[0]!(mutate);await drain();assert.equal(legacy,2);
});
console.log(JSON.stringify({schema:'RBRIDGE_W1_V3_EFFECT_LEDGER_QUALIFICATION_V1',status:failed===0?'PASS':'FAIL',passed,failed}));
if(failed)throw Error('W1_V3_EFFECT_LEDGER_FAILED:'+failed);
