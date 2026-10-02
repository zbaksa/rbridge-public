import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {NativeHostRuntimeV1} from '../src/nativeHost/nativeHostRuntime.js';
import {parseNativeHostConfigV1} from '../src/nativeHost/nativeHostConfig.js';
import {NativeMessageDecoder,encodeNativeMessage} from '../src/transport/nativeMessaging.js';
import {StdioFrameDecoder,encodeStdioFrame} from '../src/transport/sshStdio.js';
import type {SshProcessHandleV1} from '../src/nativeHost/persistentSshSession.js';
import {REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalDigest,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope,type VerifiedPeerV3} from '../src/domain/rbridgeEffectProtocol.js';

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
class FakeSsh implements SshProcessHandleV1 {
  writes:Uint8Array[]=[];killed=false;
  private data:(bytes:Uint8Array)=>void=()=>{};
  private closed:(code:number|null,signal:string|null)=>void=()=>{};
  write(bytes:Uint8Array){this.writes.push(bytes);}
  onData(fn:(bytes:Uint8Array)=>void){this.data=fn;}
  onClose(fn:(code:number|null,signal:string|null)=>void){this.closed=fn;}
  onError(_fn:(error:Error)=>void){void _fn;}
  kill(){this.killed=true;}
  emit(value:unknown){this.data(encodeStdioFrame(value));}
  emitBytes(bytes:Uint8Array){this.data(bytes);}
  close(){this.closed(255,null);}
}
function runtimeConfig(path:string){return {
  schema:'RBRIDGE_NATIVE_HOST_CONFIG_V1',expectedExtensionId:'a'.repeat(32),eventStoreRoot:path,
  ssh:{sshPath:join(path,'ssh'),host:'aether-engine',port:22,user:'rbridge' as const,identityFile:join(path,'id'),knownHostsFile:join(path,'known-hosts')},
  v3:{scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}},
};}
async function until(fn:()=>boolean):Promise<void>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.ok(fn(),'NATIVE_RUNTIME_OPERATION_DID_NOT_SETTLE');}
function runtime(path:string){
  const ssh=new FakeSsh(),output:Uint8Array[]=[],errors:string[]=[];
  const host=new NativeHostRuntimeV1(runtimeConfig(path),{write:bytes=>output.push(bytes)},{onProtocolError:e=>{errors.push(e.message);}},{processFactory:{launch:()=>ssh},scheduler:{set:()=>null,clear:()=>{}}});
  host.start(['chrome-extension://'+'a'.repeat(32)+'/']);
  return {host,ssh,output,errors};
}
await test('native_private_config_accepts_only_complete_strict_v3_pins',()=>root(async path=>{
  const config=runtimeConfig(path),parsed=parseNativeHostConfigV1(config) as unknown as {v3:unknown};
  assert.deepEqual(parsed.v3,config.v3);
  for(const v3 of [{...config.v3,arbitraryExecutable:'denied'},{...config.v3,scope:{...scope,appId:'-bad'}},{...config.v3,peerPins:{...pins,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES]}},{...config.v3,peerPins:{...pins,arbitraryRoot:path}},{...config.v3,initialHistory:{sequence:1,eventSha256:null}}])assert.throws(()=>parseNativeHostConfigV1({...config,v3}));
  config.v3.peerPins={...pins,releaseSha:'2'.repeat(40)};assert.equal((parsed.v3 as {peerPins:VerifiedPeerV3}).peerPins.releaseSha,pins.releaseSha);
}));
await test('native_runtime_reserves_before_framed_browser_output',()=>root(async path=>{
  const {host,ssh,output,errors}=runtime(path);
  try{
    await host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>ssh.writes.length===1);
    ssh.emit(hello);await until(()=>output.length===1||errors.length>0);assert.deepEqual(errors,[]);assert.equal(host.protocolReady,true);
    ssh.emit(bind.command);await until(()=>output.length===2||errors.length>0);assert.deepEqual(errors,[]);
    const frame=new NativeMessageDecoder().push(output[1]!);assert.deepEqual(frame,[bind.command]);
    const results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});assert.deepEqual((await results.read(bind.command.commandId))?.command,bind.command);
    await host.acceptNativeChunk(encodeNativeMessage(bind.result));assert.deepEqual((await results.read(bind.command.commandId))?.result,bind.result);
    assert.deepEqual(new StdioFrameDecoder().push(ssh.writes.at(-1)!),[bind.result]);
  }finally{host.stop();}
}));
await test('native_runtime_restart_replays_exact_framed_event_and_result',()=>root(async path=>{
  const first=runtime(path),original=await event();
  try{
    await first.host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>first.ssh.writes.length===1);first.ssh.emit(hello);await until(()=>first.host.protocolReady||first.errors.length>0);assert.deepEqual(first.errors,[]);
    first.ssh.emit(bind.command);await until(()=>first.output.length===2||first.errors.length>0);assert.deepEqual(first.errors,[]);
    await first.host.acceptNativeChunk(encodeNativeMessage(original));await first.host.acceptNativeChunk(encodeNativeMessage(bind.result));
  }finally{first.host.stop();}
  const next=runtime(path);
  try{
    await next.host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>next.ssh.writes.length===1);next.ssh.emit(hello);await until(()=>next.output.length===1||next.errors.length>0);assert.deepEqual(next.errors,[]);
    const decoder=new StdioFrameDecoder(),replayed=next.ssh.writes.flatMap(bytes=>decoder.push(bytes));assert.deepEqual(replayed,[hello,original,bind.result]);
  }finally{next.host.stop();}
}));
await test('private_peer_marker_corruption_blocks_restart_without_relabeling',()=>root(async path=>{
  const a=await make(path);await ready(a.relay);await a.relay.acceptServerMessage(send.command);
  await writeFile(join(path,'v3-peer-owner.json'),'{}\n',{mode:0o600});
  const b=await make(path);await assert.rejects(()=>b.relay.acceptBrowserMessage(hello),/OWNER|PIN/);
  assert.deepEqual((await a.results.read(send.command.commandId))?.command,send.command);
}));
await test('disconnect_during_reservation_blocks_dispatch_but_retains_original',()=>root(async path=>{
  const {relay,results}=await make(path);await ready(relay);const reserve=results.reserve.bind(results);
  results.reserve=async input=>{const command=await reserve(input);relay.peerDisconnected();return command;};
  await assert.rejects(()=>relay.acceptServerMessage(bind.command),/CONNECTION_CHANGED/);
  assert.deepEqual((await results.read(bind.command.commandId))?.command,bind.command);
}));
await test('queued_wire_mutation_does_not_change_reserved_command',()=>root(async path=>{
  const {relay,results}=await make(path);await ready(relay);const input=structuredClone(bind.command);
  const pending=relay.acceptServerMessage(input);input.commandId='mutated-after-call';
  assert.deepEqual((await pending).message.value,bind.command);assert.deepEqual((await results.read(bind.command.commandId))?.command,bind.command);
}));
async function rehash(command:RbridgeChatEffectCommandV1){
  const {requestDigest:priorRequest,...request}=command.request;void priorRequest;command.request.requestDigest=await canonicalDigest(request);
  const {commandSha256:priorCommand,...body}=command;void priorCommand;command.commandSha256=await canonicalDigest(body);return command;
}
await test('validly_rehashed_wrong_browser_target_is_not_reserved_or_dispatched',()=>root(async path=>{
  const {relay,results}=await make(path);await ready(relay);
  for(const key of ['browserInstanceId','browserProfileId'] as const){
    const bad=structuredClone(bind.command);bad.commandId+=':'+key;bad.request.payload.target[key]='wrong-pinned-target';await rehash(bad);
    await assert.rejects(()=>relay.acceptServerMessage(bad),/PIN|TARGET/);assert.equal(await results.read(bad.commandId),null);
  }
}));
await test('invalid_input_rejects_async_api_without_executing_accessors',()=>root(async path=>{
  const {relay}=await make(path);await ready(relay);let calls=0;
  const value=structuredClone(bind.command);Object.defineProperty(value,'commandId',{enumerable:true,get:()=>{calls++;return 'forbidden-getter';}});
  await assert.rejects(()=>relay.acceptServerMessage(value),/INPUT_INVALID/);assert.equal(calls,0);
  await assert.rejects(()=>relay.acceptBrowserMessage('x'.repeat(65536)),/BUDGET/);
}));
await test('configured_small_peer_budget_rejects_complete_oversize_command',()=>root(async path=>{
  const smallPins={...pins,maxMessageBytes:4096},smallHello={...hello,maxMessageBytes:4096};
  const {relay,results}=await make(path,{pins:smallPins});await relay.acceptBrowserMessage(smallHello);await relay.peerConnected();await relay.acceptServerMessage(smallHello);
  const large=structuredClone(send.command);assert.ok('text' in large.request.payload);large.request.payload.text='x'.repeat(48000);await rehash(large);
  await assert.rejects(()=>relay.acceptServerMessage(large),/BUDGET/);assert.equal(await results.read(large.commandId),null);
}));
for(const completed of [false,true])await test('unbound_'+(completed?'complete':'pending')+'_result_history_cannot_acquire_new_peer_owner',()=>root(async path=>{
  const events=new RbridgeChatEventStoreV1({root:path});await events.load();
  const results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});
  await results.reserve(completed?bind.command:send.command);if(completed)await results.record(bind.result);
  const journal=await readFile(join(path,'v3-results/journal.json')),owner=await readFile(join(path,'v3-results/authority.json'));
  const newPins={...pins,peerId:'different-fixed-peer',browserProfileId:'different-profile'},newHello={...hello,browserProfileId:newPins.browserProfileId};
  const {relay,messages}=await make(path,{pins:newPins});await assert.rejects(()=>relay.acceptBrowserMessage(newHello),/HISTORY|OWNERSHIP/);
  await assert.rejects(()=>readFile(join(path,'v3-peer-owner.json')),/ENOENT/);assert.equal(messages.length,0);
  assert.deepEqual(await readFile(join(path,'v3-results/journal.json')),journal);assert.deepEqual(await readFile(join(path,'v3-results/authority.json')),owner);
}));
await test('unbound_cross_app_journal_cannot_poison_rightful_peer_owner',()=>root(async path=>{
  const events=new RbridgeChatEventStoreV1({root:path});await events.load();
  const results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});await results.reserve(send.command);
  const journal=await readFile(join(path,'v3-results/journal.json'));
  const other=await make(path,{scope:{...scope,appId:'other-app'}});
  await assert.rejects(()=>other.relay.acceptBrowserMessage(hello),/OWNER|OWNERSHIP|HISTORY/);
  await assert.rejects(()=>readFile(join(path,'v3-peer-owner.json')),/ENOENT/);assert.deepEqual(await readFile(join(path,'v3-results/journal.json')),journal);
}));
async function replacedRuntime(path:string){
  const handles:FakeSsh[]=[],scheduled:(()=>void)[]=[],output:Uint8Array[]=[],errors:string[]=[];
  const host=new NativeHostRuntimeV1(runtimeConfig(path),{write:bytes=>output.push(bytes)},{onProtocolError:e=>{errors.push(e.message);},onTransportError:e=>{errors.push(e.message);}},{processFactory:{launch:()=>{const ssh=new FakeSsh();handles.push(ssh);return ssh;}},scheduler:{set:(_delay,fn)=>{scheduled.push(fn);return fn;},clear:()=>{}}});
  try{
    host.start(['chrome-extension://'+'a'.repeat(32)+'/']);await host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>handles[0]!.writes.length===1);
    handles[0]!.emit(hello);await until(()=>output.length===1||errors.length>0);assert.deepEqual(errors,[]);
    handles[0]!.close();await until(()=>scheduled.length===1);scheduled[0]!();await until(()=>handles.length===2&&handles[1]!.writes.length===1);
    handles[1]!.emit(hello);await until(()=>output.length===2||errors.length>0);assert.deepEqual(errors,[]);
    return {host,old:handles[0]!,current:handles[1]!,output,errors};
  }catch(error){host.stop();throw error;}
}
await test('inactive_ssh_child_complete_frame_has_no_new_channel_authority',()=>root(async path=>{
  const {host,old,current,output,errors}=await replacedRuntime(path);
  try{
    old.emit(bind.command);await new Promise(r=>setTimeout(r,30));assert.equal(output.length,2);assert.deepEqual(errors,[]);
    const results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});assert.equal(await results.read(bind.command.commandId),null);
    current.emit(bind.command);await until(()=>output.length===3||errors.length>0);assert.deepEqual(errors,[]);assert.deepEqual(new NativeMessageDecoder().push(output[2]!),[bind.command]);
  }finally{host.stop();}
}));
await test('inactive_ssh_child_partial_frame_cannot_corrupt_current_decoder',()=>root(async path=>{
  const {host,old,current,output,errors}=await replacedRuntime(path);
  try{
    old.emitBytes(new TextEncoder().encode('{"schema":"RBRIDGE'));current.emit(bind.command);
    await until(()=>output.length===3||errors.length>0);assert.deepEqual(errors,[]);assert.equal(host.protocolReady,true);
    assert.deepEqual(new NativeMessageDecoder().push(output[2]!),[bind.command]);
  }finally{host.stop();}
}));
await test('oversize_anchored_legacy_event_is_preserved_without_replay_transmission',()=>root(async path=>{
  const spool=new RbridgeEventSpoolV1(),original=await spool.append({eventId:'legacy-large-event',eventType:'RESPONSE_CAPTURED',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:'2026-10-02T11:00:00.000Z',payload:{captureReceipt:{schema:'COCWIN_RECEIPT_REF_V1',receiptId:'legacy-large-receipt',receiptSchema:'RBRIDGE_TEST_RECEIPT_V1',sha256:'d'.repeat(64)},machineBlockUtf8:'x'.repeat(5000)}});
  const events=new RbridgeChatEventStoreV1({root:path});await events.append(original);
  const smallHello={...hello,maxMessageBytes:4096},{relay,messages}=await make(path,{pins:{...pins,maxMessageBytes:4096},anchor:{sequence:original.sequence,eventSha256:original.eventSha256}});
  await relay.acceptBrowserMessage(smallHello);await relay.peerConnected();await assert.rejects(()=>relay.acceptServerMessage(smallHello),/BUDGET/);
  assert.equal(relay.protocolReady,false);assert.deepEqual(messages,[smallHello]);assert.deepEqual(await events.load(),[original]);
}));
console.log(JSON.stringify({suite:'W1_V3_NATIVE_TRANSPORT',passed,failed,liveAcceptance:'NOT_RUN',fixedLinuxEndpoint:'NOT_IMPLEMENTED_IN_THIS_INCREMENT'}));
if(failed)process.exitCode=1;
