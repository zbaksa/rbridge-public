import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope,type VerifiedPeerV3} from '../src/domain/rbridgeEffectProtocol.js';

type Authority=object;
interface Relay {
  readonly protocolReady:boolean;
  acceptBrowserMessage(value:unknown):Promise<string>;
  acceptServerMessage(value:unknown):Promise<{message:{kind:string;value:unknown};replayedEvents:number;replayedResults:number}>;
  peerConnected():Promise<string>;
  peerDisconnected():void;
}
interface AuthorityOptions {eventStoreRoot:string;appId:string;peerPins:VerifiedPeerV3;initialHistory:{sequence:number;eventSha256:string|null}}
const authorityPath='../src/nativeHost/nativeV3PeerAuthority.js';
const authorityModule=await import(authorityPath).catch(()=>null) as {NativeV3PeerAuthority:new(options:AuthorityOptions)=>Authority}|null;
const RelayClass=NativeHostRelayV1 as unknown as new(store:RbridgeChatEventStoreV1,peer:{send(value:unknown):Promise<void>},v3:{results:RbridgeEffectResultStoreV3;authority:Authority})=>Relay;
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!,send=fixture.vectors[1]!;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
const target=bind.command.request.payload.target;
const pins:VerifiedPeerV3={peerId:'fixed-rbridge-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES,'CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2']};
const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:pins.releaseSha,browserInstanceId:pins.browserInstanceId,browserProfileId:pins.browserProfileId,maxMessageBytes:pins.maxMessageBytes,capabilities:[...pins.capabilities],nativeHostVersion:'1.0.0'};
async function root(fn:(path:string)=>Promise<void>):Promise<void>{const path=await realpath(await mkdtemp(join(tmpdir(),'rbridge-native-transport-')));try{await fn(path);}finally{await rm(path,{recursive:true,force:true});}}
async function make(path:string,options:{scope?:V3Scope;pins?:VerifiedPeerV3;anchor?:AuthorityOptions['initialHistory'];send?:(value:unknown)=>Promise<void>}={}){
  assert.ok(authorityModule?.NativeV3PeerAuthority,'NATIVE_V3_PEER_AUTHORITY_NOT_IMPLEMENTED');
  const events=new RbridgeChatEventStoreV1({root:path});await events.load();
  const current=options.scope??scope,results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope:current,maxMessageBytes:65536});
  const authority=new authorityModule.NativeV3PeerAuthority({eventStoreRoot:path,appId:current.appId,peerPins:options.pins??pins,initialHistory:options.anchor??{sequence:0,eventSha256:null}});
  const messages:unknown[]=[];const relay=new RelayClass(events,{send:async value=>{await options.send?.(value);messages.push(structuredClone(value));}},{results,authority});
  return {relay,events,results,messages};
}
async function ready(relay:Relay):Promise<void>{await relay.acceptBrowserMessage(hello);await relay.peerConnected();await relay.acceptServerMessage(hello);assert.equal(relay.protocolReady,true);}
async function event(){
  const spool=new RbridgeEventSpoolV1();
  return await spool.append({eventId:'native-original-event-1',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:'2026-10-02T11:00:00.000Z',payload:{reason:'UI_PROTOCOL_CHANGED'}});
}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_NATIVE_TRANSPORT '+name);}catch(error){failed++;console.error('FAIL V3_NATIVE_TRANSPORT '+name+': '+String(error));}}

await test('command_is_durably_reserved_before_browser_dispatch',()=>root(async path=>{
  const {relay,results}=await make(path);await ready(relay);
  const accepted=await relay.acceptServerMessage(bind.command);
  assert.equal(accepted.message.kind,'EFFECT_COMMAND');assert.deepEqual(accepted.message.value,bind.command);
  assert.deepEqual(await results.read(bind.command.commandId),{command:bind.command,result:null});
}));
await test('late_result_durable_before_forward_and_disconnect_keeps_original',()=>root(async path=>{
  let checked=false;
  const {relay,results}=await make(path,{send:async value=>{
    if((value as {schema?:unknown}).schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1'){
      checked=true;assert.deepEqual((await results.read(bind.command.commandId))?.result,bind.result);
      throw Error('TEST_PEER_DISCONNECTED');
    }
  }});
  await ready(relay);await relay.acceptServerMessage(bind.command);
  await assert.rejects(()=>relay.acceptBrowserMessage(bind.result),/TEST_PEER_DISCONNECTED/);assert.equal(checked,true);
  const reopened=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});
  assert.deepEqual((await reopened.read(bind.command.commandId))?.result,bind.result);
}));
await test('offline_complete_result_is_retained_for_authenticated_reconnect',()=>root(async path=>{
  const {relay,results,messages}=await make(path);await ready(relay);await relay.acceptServerMessage(bind.command);
  relay.peerDisconnected();const before=messages.length;
  assert.equal(await relay.acceptBrowserMessage(bind.result),'EFFECT_RESULT_DURABLE_QUEUED');
  assert.equal(messages.length,before);assert.deepEqual((await results.read(bind.command.commandId))?.result,bind.result);
  await relay.peerConnected();const replay=await relay.acceptServerMessage(hello);
  assert.equal(replay.replayedResults,1);assert.deepEqual(messages.at(-1),bind.result);
}));
await test('native_restart_preserves_result_and_original_v1_event_chain',()=>root(async path=>{
  const a=await make(path);await ready(a.relay);await a.relay.acceptServerMessage(bind.command);
  const original=await event();await a.relay.acceptBrowserMessage(original);await a.relay.acceptBrowserMessage(bind.result);
  const b=await make(path);await b.relay.acceptBrowserMessage(hello);await b.relay.peerConnected();
  const replay=await b.relay.acceptServerMessage(hello);
  assert.equal(replay.replayedEvents,1);assert.equal(replay.replayedResults,1);
  assert.deepEqual(b.messages,[hello,original,bind.result]);assert.deepEqual(await b.events.load(),[original]);
}));
await test('forged_or_unreserved_result_never_reaches_peer',()=>root(async path=>{
  const {relay,results,messages}=await make(path);await ready(relay);const before=messages.length;
  await assert.rejects(()=>relay.acceptBrowserMessage(bind.result),/COMMAND_MISSING|COMMAND_UNKNOWN/);
  await relay.acceptServerMessage(bind.command);
  await assert.rejects(()=>relay.acceptBrowserMessage({...bind.result,resultSha256:'0'.repeat(64)}),/DIGEST_MISMATCH/);
  assert.equal(messages.length,before);assert.equal((await results.read(bind.command.commandId))?.result,null);
}));
await test('failed_result_readback_blocks_forwarding',()=>root(async path=>{
  const {relay,results,messages}=await make(path);await ready(relay);await relay.acceptServerMessage(bind.command);
  const before=messages.length;await writeFile(join(path,'v3-results','journal.json'),'{}\n',{mode:0o600});
  await assert.rejects(()=>relay.acceptBrowserMessage(bind.result),/JOURNAL_INVALID/);
  assert.equal(messages.length,before);await assert.rejects(()=>results.replay(),/JOURNAL_INVALID/);
}));
await test('peer_release_profile_and_capability_mismatch_block_before_dispatch',()=>root(async path=>{
  const {relay,messages}=await make(path);await relay.acceptBrowserMessage(hello);await relay.peerConnected();const before=messages.length;
  for(const bad of [{...hello,releaseSha:'2'.repeat(40)},{...hello,browserProfileId:'wrong-profile'},{...hello,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES]},{...hello,maxMessageBytes:4096}]){
    await assert.rejects(()=>relay.acceptServerMessage(bad),/PIN|PEER|CAPABILITY|MESSAGE/);assert.equal(relay.protocolReady,false);
  }
  await assert.rejects(()=>relay.acceptServerMessage(bind.command),/NOT_NEGOTIATED/);assert.equal(messages.length,before);
}));
await test('browser_hello_also_requires_configured_release_and_profile',()=>root(async path=>{
  const {relay,messages}=await make(path);
  await assert.rejects(()=>relay.acceptBrowserMessage({...hello,releaseSha:'2'.repeat(40)}),/PIN|PEER/);
  await assert.rejects(()=>relay.acceptBrowserMessage({...hello,browserProfileId:'wrong-profile'}),/PIN|PEER/);
  assert.equal(messages.length,0);assert.equal(relay.protocolReady,false);
}));
await test('new_generation_archives_original_late_result_without_new_scope_authority',()=>root(async path=>{
  const old=await make(path);await ready(old.relay);await old.relay.acceptServerMessage(bind.command);
  const newerScope={...scope,generation:'223e4567-e89b-42d3-a456-426614174000'};
  const current=await make(path,{scope:newerScope});await ready(current.relay);
  assert.equal(await current.results.read(bind.command.commandId),null);
  await assert.rejects(()=>current.results.record(bind.result),/SCOPE_MISMATCH/);
  await current.relay.acceptBrowserMessage(bind.result);
  assert.equal(await current.results.read(bind.command.commandId),null);
  assert.deepEqual(await current.results.replay(),[bind.result]);
}));
await test('unknown_legacy_stream_ownership_blocks_upgrade_without_reset',()=>root(async path=>{
  const events=new RbridgeChatEventStoreV1({root:path}),original=await event();await events.append(original);
  const {relay,messages}=await make(path);
  await assert.rejects(()=>relay.acceptBrowserMessage(hello),/HISTORY|OWNERSHIP/);
  assert.deepEqual(await events.load(),[original]);assert.equal(messages.length,0);
}));
await test('trusted_full_history_anchor_preserves_existing_sequence',()=>root(async path=>{
  const events=new RbridgeChatEventStoreV1({root:path}),original=await event();await events.append(original);
  const {relay,messages}=await make(path,{anchor:{sequence:original.sequence,eventSha256:original.eventSha256}});
  await ready(relay);assert.deepEqual(messages,[hello,original]);
}));
await test('peer_owner_cannot_switch_across_session_generations',()=>root(async path=>{
  const a=await make(path);await ready(a.relay);await a.relay.acceptServerMessage(send.command);
  const other=await make(path,{scope:{...scope,appId:'other-app'}});
  await assert.rejects(()=>other.relay.acceptBrowserMessage(hello),/OWNER|OWNERSHIP/);
  assert.deepEqual((await a.results.read(send.command.commandId))?.command,send.command);
}));
await test('v3_authority_cannot_downgrade_on_peer_reconnect',()=>root(async path=>{
  const {relay}=await make(path);await ready(relay);relay.peerDisconnected();await relay.peerConnected();
  await assert.rejects(()=>relay.acceptServerMessage({...hello,protocolMinor:0,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES]}),/PIN|PEER|CAPABILITY|DOWNGRADE/);
  assert.equal(relay.protocolReady,false);
}));
console.log(JSON.stringify({suite:'W1_V3_NATIVE_TRANSPORT',passed,failed,liveAcceptance:'NOT_RUN',fixedLinuxEndpoint:'NOT_IMPLEMENTED_IN_THIS_INCREMENT'}));
if(failed)process.exitCode=1;
