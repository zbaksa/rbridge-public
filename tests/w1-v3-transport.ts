import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureChild} from './w1-v3-peer-process-fixture.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalDigest,canonicalJson,sha256Hex,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope,type VerifiedPeerV3} from '../src/domain/rbridgeEffectProtocol.js';

interface Chunk {schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1';commandId:string;commandSha256:string;requestDigest:string;transferSha256:string;totalBytes:number;chunkCount:number;index:number;offset:number;dataBase64:string}
interface Commit {schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1';commandId:string;commandSha256:string;requestDigest:string;transferSha256:string;totalBytes:number;chunkCount:number}
interface PeerStore {
  stageChunk(chunk:unknown):Promise<void>;
  commitCommand(commit:unknown):Promise<void>;
  enqueue(command:RbridgeChatEffectCommandV1,scope:V3Scope):Promise<void>;
  recordIncoming(input:unknown,peer:VerifiedPeerV3):Promise<void>;
  read(id:string,scope:V3Scope):Promise<{result:RbridgeChatEffectResultV1|null;events:RbridgeChatEventV1[]}>;
  takeForDispatch():Promise<RbridgeChatEffectCommandV1|null>;
  peer():Promise<VerifiedPeerV3>;
  readEvent(afterSequence:number):Promise<RbridgeChatEventV1|null>;
  disconnect():Promise<void>;
  heartbeat():Promise<void>;
}
const modulePath='../src/server/rbridgeChatPeerStore.js';
const peerModule=await import(modulePath).catch(()=>null) as {RbridgeChatPeerStoreV3:new(root:string)=>PeerStore}|null;
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!,send=fixture.vectors[1]!;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
const target=bind.command.request.payload.target;
const pins:VerifiedPeerV3={peerId:'fixed-rbridge-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES,'CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2']};
const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:pins.releaseSha,browserInstanceId:pins.browserInstanceId,browserProfileId:pins.browserProfileId,maxMessageBytes:pins.maxMessageBytes,capabilities:[...pins.capabilities],nativeHostVersion:'1.0.0'};
async function root(fn:(path:string)=>Promise<void>):Promise<void>{const path=await realpath(await mkdtemp(join(tmpdir(),'rbridge-fixed-peer-')));try{await fn(path);}finally{await rm(path,{recursive:true,force:true});}}
async function config(path:string,current:V3Scope=scope){await writeFile(join(path,'v3-peer-config.json'),canonicalJson({schema:'RBRIDGE_CHAT_PEER_CONFIG_V3',scope:current,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}})+'\n',{mode:0o600});}
async function make(path:string){assert.ok(peerModule?.RbridgeChatPeerStoreV3,'FIXED_LINUX_PEER_STORE_NOT_IMPLEMENTED');await config(path);return new peerModule.RbridgeChatPeerStoreV3(path);}
async function ready(store:PeerStore){await store.recordIncoming(hello,pins);assert.deepEqual(await store.peer(),pins);}
async function chunks(command:RbridgeChatEffectCommandV1){
  const bytes=Buffer.from(canonicalJson(command)),transferSha256=await sha256Hex(bytes),chunkCount=Math.ceil(bytes.length/3072);
  const commit:Commit={schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1',commandId:command.commandId,commandSha256:command.commandSha256,requestDigest:command.request.requestDigest,transferSha256,totalBytes:bytes.length,chunkCount};
  const result:Chunk[]=Array.from({length:chunkCount},(_,index)=>({...commit,schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1',index,offset:index*3072,dataBase64:bytes.subarray(index*3072,Math.min((index+1)*3072,bytes.length)).toString('base64')}));
  return {chunks:result,commit,bytes};
}
async function rehash(command:RbridgeChatEffectCommandV1){const {requestDigest:prior,...request}=command.request;void prior;command.request.requestDigest=await canonicalDigest(request);const {commandSha256:old,...body}=command;void old;command.commandSha256=await canonicalDigest(body);return command;}
async function originalEvent(){return new RbridgeEventSpoolV1().append({eventId:'fixed-original-event-1',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:'2026-10-02T12:00:00.000Z',payload:{reason:'UI_PROTOCOL_CHANGED'}});}
let passed=0,failed=0,skipped=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_FIXED_PEER '+name);}catch(e){failed++;console.error('FAIL V3_FIXED_PEER '+name+': '+String(e));}}

await test('partial_enqueue_stays_uncertain',()=>root(async path=>{
  const store=await make(path);await ready(store);const full=structuredClone(send.command);if('text' in full.request.payload)full.request.payload.text='x'.repeat(48000);await rehash(full);
  const transfer=await chunks(full);await store.stageChunk(transfer.chunks[0]);
  await assert.rejects(()=>store.commitCommand(transfer.commit),/PARTIAL_COMMAND_UNCERTAIN/);
  assert.equal(await store.takeForDispatch(),null);assert.equal((await store.read(full.commandId,scope)).result,null);
}));
await test('full_48000_byte_command_requires_bounded_immutable_chunks',()=>root(async path=>{
  const store=await make(path);await ready(store);const full=structuredClone(send.command);if('text' in full.request.payload)full.request.payload.text='x'.repeat(48000);await rehash(full);
  const transfer=await chunks(full);assert.ok(transfer.bytes.length>48000);assert.ok(transfer.chunks.length>1);
  for(const chunk of transfer.chunks){assert.ok(Buffer.byteLength(chunk.dataBase64)<=4096);assert.ok(Buffer.byteLength(JSON.stringify(chunk))<8192);await store.stageChunk(chunk);assert.equal(await store.takeForDispatch(),null);}
  await store.commitCommand(transfer.commit);assert.deepEqual(await store.takeForDispatch(),full);assert.equal(await store.takeForDispatch(),null);
  await store.disconnect();assert.ok(peerModule);const reopened=new peerModule.RbridgeChatPeerStoreV3(path);await ready(reopened);assert.equal(await reopened.takeForDispatch(),null,'uncertain dispatched EXECUTE must not be blindly resent');
}));
await test('chunk_and_complete_commit_replays_are_idempotent',()=>root(async path=>{
  const store=await make(path);await ready(store);const transfer=await chunks(bind.command);
  for(const c of transfer.chunks){await store.stageChunk(c);await store.stageChunk(structuredClone(c));}
  await store.commitCommand(transfer.commit);await store.commitCommand(transfer.commit);assert.deepEqual(await store.takeForDispatch(),bind.command);assert.equal(await store.takeForDispatch(),null);
}));
await test('altered_chunk_offset_count_and_base64_are_rejected',()=>root(async path=>{
  const store=await make(path);await ready(store);const t=await chunks(bind.command),c=t.chunks[0]!;
  for(const bad of [{...c,offset:1},{...c,index:c.chunkCount},{...c,chunkCount:c.chunkCount+1},{...c,totalBytes:65537},{...c,dataBase64:c.dataBase64+'\n'},{...c,dataBase64:'a'.repeat(4097)},{...c,host:'unapproved'}])await assert.rejects(()=>store.stageChunk(bad));
  assert.equal(await store.takeForDispatch(),null);
}));
await test('tampered_complete_transfer_hash_cannot_enqueue',()=>root(async path=>{
  const store=await make(path);await ready(store);const t=await chunks(bind.command);for(const c of t.chunks)await store.stageChunk({...c,transferSha256:'0'.repeat(64)});
  await assert.rejects(()=>store.commitCommand({...t.commit,transferSha256:'0'.repeat(64)}),/DIGEST|HASH/);assert.equal(await store.takeForDispatch(),null);
}));
await test('stable_chunk_identity_cannot_be_overwritten',()=>root(async path=>{
  const store=await make(path);await ready(store);const t=await chunks(bind.command),c=t.chunks[0]!;await store.stageChunk(c);
  const bytes=Buffer.from(c.dataBase64,'base64');bytes[0]=bytes[0]!^1;
  await assert.rejects(()=>store.stageChunk({...c,dataBase64:bytes.toString('base64')}),/COLLISION/);assert.equal(await store.takeForDispatch(),null);
}));
await test('complete_command_identity_must_match_every_stage_claim',()=>root(async path=>{
  const store=await make(path);await ready(store);const t=await chunks(bind.command);
  for(const c of t.chunks)await store.stageChunk({...c,commandId:'different-command'});
  await assert.rejects(()=>store.commitCommand({...t.commit,commandId:'different-command'}),/IDENTITY|CORRELATION/);assert.equal(await store.takeForDispatch(),null);
}));
await test('cross_app_or_foreign_scope_cannot_enqueue_or_read',()=>root(async path=>{
  const store=await make(path);await ready(store);
  await assert.rejects(()=>store.enqueue(bind.command,{...scope,appId:'other-app'}),/SCOPE|OWNER/);
  await assert.rejects(()=>store.read(bind.command.commandId,{...scope,appId:'other-app'}),/SCOPE|OWNER/);
  const wrong=structuredClone(bind.command);wrong.request.appId='other-app';await rehash(wrong);await assert.rejects(()=>store.enqueue(wrong,{...scope,appId:'other-app'}),/SCOPE|OWNER/);assert.equal(await store.takeForDispatch(),null);
}));
await test('missing_capability_release_profile_and_ceiling_block_peer',()=>root(async path=>{
  const store=await make(path);
  for(const bad of [{...hello,releaseSha:'2'.repeat(40)},{...hello,browserProfileId:'foreign-profile'},{...hello,maxMessageBytes:4096},{...hello,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES]}])await assert.rejects(()=>store.recordIncoming(bad,pins),/PIN|PEER|CAPABILITY|MESSAGE/);
  await assert.rejects(()=>store.peer(),/NOT_NEGOTIATED|UNAVAILABLE/);await assert.rejects(()=>store.enqueue(bind.command,scope),/NOT_NEGOTIATED|UNAVAILABLE/);
}));
await test('disconnect_invalidates_peer_without_deleting_unresolved_command',()=>root(async path=>{
  const store=await make(path);await ready(store);await store.enqueue(bind.command,scope);await store.disconnect();await assert.rejects(()=>store.peer(),/NOT_NEGOTIATED|UNAVAILABLE/);
  assert.ok(peerModule);const next=new peerModule.RbridgeChatPeerStoreV3(path);await ready(next);assert.deepEqual(await next.takeForDispatch(),bind.command);
}));
await test('native_restart_preserves_result_and_event_chain',()=>root(async path=>{
  const store=await make(path);await ready(store);await store.enqueue(bind.command,scope);assert.deepEqual(await store.takeForDispatch(),bind.command);
  const event=await originalEvent();await store.recordIncoming(event,pins);await store.recordIncoming(bind.result,pins);
  await store.disconnect();assert.ok(peerModule);const reopened=new peerModule.RbridgeChatPeerStoreV3(path);await ready(reopened);const value=await reopened.read(bind.command.commandId,scope);
  assert.equal(value.result?.resultSha256,bind.result.resultSha256);assert.deepEqual(value.result,bind.result);assert.deepEqual(value.events,[event]);assert.deepEqual(await reopened.readEvent(0),event);assert.equal(await reopened.readEvent(1),null);
}));
await test('forged_unreserved_or_wrong_pinned_result_is_rejected',()=>root(async path=>{
  const store=await make(path);await ready(store);await assert.rejects(()=>store.recordIncoming(bind.result,pins),/COMMAND_MISSING|COMMAND_UNKNOWN/);await store.enqueue(bind.command,scope);
  await assert.rejects(()=>store.recordIncoming({...bind.result,resultSha256:'0'.repeat(64)},pins),/DIGEST/);
  await assert.rejects(()=>store.recordIncoming(bind.result,{...pins,peerId:'foreign-peer'}),/PIN|PEER/);assert.equal((await store.read(bind.command.commandId,scope)).result,null);
}));
await test('event_gap_collision_and_foreign_session_cannot_reset_history',()=>root(async path=>{
  const store=await make(path);await ready(store);const event=await originalEvent();await store.recordIncoming(event,pins);await store.recordIncoming(event,pins);
  const {eventSha256:old,...body}=event;void old;const gap={...body,eventId:'gap-event',sequence:3,previousEventSha256:event.eventSha256};
  const gapSha=await canonicalDigest(gap);await assert.rejects(()=>store.recordIncoming({...gap,eventSha256:gapSha},pins),/GAP|SEQUENCE/);
  const collision={...body,payload:{reason:'COLLISION'}},collisionSha=await canonicalDigest(collision);await assert.rejects(()=>store.recordIncoming({...collision,eventSha256:collisionSha},pins),/COLLISION/);
  assert.deepEqual(await store.readEvent(0),event);
}));
await test('unverifiable_legacy_history_blocks_without_relabel_or_reset',()=>root(async path=>{
  const events=new RbridgeChatEventStoreV1({root:path}),event=await originalEvent();await events.append(event);const store=await make(path);
  await assert.rejects(()=>store.recordIncoming(hello,pins),/HISTORY|OWNERSHIP/);assert.deepEqual(await events.load(),[event]);
}));
await test('new_generation_archives_original_result_without_current_authority',()=>root(async path=>{
  const old=await make(path);await ready(old);await old.enqueue(send.command,scope);assert.deepEqual(await old.takeForDispatch(),send.command);
  await old.disconnect();const newer={...scope,generation:'223e4567-e89b-42d3-a456-426614174000'};await config(path,newer);assert.ok(peerModule);const current=new peerModule.RbridgeChatPeerStoreV3(path);await ready(current);await current.recordIncoming(send.result,pins);
  assert.equal((await current.read(send.command.commandId,newer)).result,null);assert.deepEqual((await current.read(send.command.commandId,scope)).result,send.result);assert.equal(await current.takeForDispatch(),null);
}));
await test('one_live_pinned_channel_cannot_be_replaced_by_another',()=>root(async path=>{
  const first=await make(path);await ready(first);assert.ok(peerModule);const other=new peerModule.RbridgeChatPeerStoreV3(path);
  await assert.rejects(()=>other.recordIncoming(hello,pins),/CHANNEL_BUSY/);assert.deepEqual(await first.peer(),pins);await first.disconnect();await ready(other);await assert.rejects(()=>first.recordIncoming(bind.result,pins),/CHANNEL_CHANGED|NOT_NEGOTIATED/);
}));
if(process.platform!=='win32')await test('unsafe_private_configuration_blocks_without_changing_permissions',()=>root(async path=>{
  const store=await make(path);await chmod(join(path,'v3-peer-config.json'),0o644);await assert.rejects(()=>store.peer(),/CONFIG|FILE|PRIVATE/);await assert.rejects(()=>store.recordIncoming(hello,pins),/CONFIG|FILE|PRIVATE/);
  assert.ok((await readFile(join(path,'v3-peer-config.json'),'utf8')).includes('RBRIDGE_CHAT_PEER_CONFIG_V3'));
}));else{skipped++;console.log('SKIP V3_FIXED_PEER private POSIX mode probe requires Linux');}


if(process.platform==='linux'){
  await test('live_cross_process_owner_serializes_without_removing_its_lock',()=>root(async path=>{
    const store=await make(path);await ready(store);const child=fixtureChild('peer-lock',path);
    try{await child.locked;let settled=false;const value=store.peer().then(v=>{settled=true;return v;});void value.catch(()=>{settled=true;});
      await new Promise(r=>setTimeout(r,150));assert.equal(settled,false,'live-owner contention must wait, not fail or steal');
      child.release();await child.done;assert.deepEqual(await value,pins);assert.deepEqual(await store.peer(),pins);
    }finally{await child.stop();}
  }));
  for(const mode of ['peer-lock','result-lock'] as const)await test('terminated_'+mode+'_owner_recovers_without_erasing_evidence',()=>root(async path=>{
    const store=await make(path);await ready(store);await store.enqueue(bind.command,scope);await store.takeForDispatch();await store.recordIncoming(bind.result,pins);
    const event=await originalEvent();await store.recordIncoming(event,pins);const child=fixtureChild(mode,path);
    try{await child.locked;await child.stop();assert.deepEqual(await store.peer(),pins);assert.deepEqual((await store.read(bind.command.commandId,scope)).result,bind.result);assert.deepEqual(await store.readEvent(0),event);assert.equal(await store.takeForDispatch(),null);}
    finally{await child.stop();}
  }));
}else{skipped+=3;console.log('SKIP V3_FIXED_PEER Linux fixed-peer kernel gate process probes');}

async function advanceGeneration(path:string,store:PeerStore){
  await store.disconnect();const newer={...scope,generation:'223e4567-e89b-42d3-a456-426614174000'};await config(path,newer);assert.ok(peerModule);
  const current=new peerModule.RbridgeChatPeerStoreV3(path);await ready(current);
  const next=structuredClone(bind.command);next.commandId='new-generation-bind';next.request.generation=newer.generation;
  next.request.effectId=await sha256Hex([next.request.sessionId,next.request.generation,next.request.attemptId,next.request.effectKind,String(next.request.effectOrdinal)].join('\0'));await rehash(next);
  return {current,newer,next};
}
async function resultFor(command:RbridgeChatEffectCommandV1,source:RbridgeChatEffectResultV1){
  const result={...structuredClone(source),commandId:command.commandId,commandSha256:command.commandSha256};
  const {resultSha256:old,...body}=result;void old;result.resultSha256=await canonicalDigest(body);return result;
}
await test('matching_terminal_reconciliation_resolves_old_send_without_relabeling',()=>root(async path=>{
  const store=await make(path);await ready(store);await store.enqueue(send.command,scope);await store.takeForDispatch();
  const reconciliation=structuredClone(send.command);reconciliation.commandId='reconcile-old-send';reconciliation.action='RECONCILE';await rehash(reconciliation);
  await store.enqueue(reconciliation,scope);await store.takeForDispatch();const result=await resultFor(reconciliation,send.result);await store.recordIncoming(result,pins);
  const {current,newer,next}=await advanceGeneration(path,store);await current.enqueue(next,newer);assert.deepEqual(await current.takeForDispatch(),next);
  assert.equal((await current.read(send.command.commandId,scope)).result,null);assert.deepEqual((await current.read(reconciliation.commandId,scope)).result,result);
  assert.equal((await current.read(reconciliation.commandId,newer)).result,null);
}));
await test('unrelated_or_nonterminal_reconciliation_does_not_resolve_old_send',()=>root(async path=>{
  const store=await make(path);await ready(store);await store.enqueue(send.command,scope);await store.takeForDispatch();
  const unrelated=structuredClone(bind.command);unrelated.commandId='unrelated-reconciliation';unrelated.action='RECONCILE';await rehash(unrelated);await store.enqueue(unrelated,scope);await store.takeForDispatch();await store.recordIncoming(await resultFor(unrelated,bind.result),pins);
  const matching=structuredClone(send.command);matching.commandId='uncertain-reconciliation';matching.action='RECONCILE';await rehash(matching);await store.enqueue(matching,scope);await store.takeForDispatch();
  const source={...structuredClone(send.result),state:'UNCERTAIN' as const,receipt:null,reason:'NOT_OBSERVED'};await store.recordIncoming(await resultFor(matching,source),pins);
  const {current,newer,next}=await advanceGeneration(path,store);await assert.rejects(()=>current.enqueue(next,newer),/PENDING_OLD_SEND/);assert.equal(await current.takeForDispatch(),null);
}));
await test('anchored_historical_duplicate_replays_without_new_scope_authority',()=>root(async path=>{
  const event=await originalEvent(),events=new RbridgeChatEventStoreV1({root:path});await events.append(event);
  const newer={...scope,generation:'223e4567-e89b-42d3-a456-426614174000'};
  await writeFile(join(path,'v3-peer-config.json'),canonicalJson({schema:'RBRIDGE_CHAT_PEER_CONFIG_V3',scope:newer,peerPins:pins,initialHistory:{sequence:event.sequence,eventSha256:event.eventSha256}})+'\n',{mode:0o600});
  assert.ok(peerModule);const store=new peerModule.RbridgeChatPeerStoreV3(path);await ready(store);await store.recordIncoming(structuredClone(event),pins);
  assert.deepEqual(await new RbridgeChatEventStoreV1({root:path}).load(),[event]);assert.deepEqual(await store.readEvent(0),event);assert.equal(await store.readEvent(1),null);
  const {eventSha256:old,...body}=event;void old;const changed={...body,payload:{reason:'CHANGED_HISTORICAL_EVENT'}};
  await assert.rejects(async()=>store.recordIncoming({...changed,eventSha256:await canonicalDigest(changed)},pins),/COLLISION/);
  assert.deepEqual(await new RbridgeChatEventStoreV1({root:path}).load(),[event]);
}));
await test('completed_uploads_release_pool_but_preserve_exact_replay_and_unfinished_upload',()=>root(async path=>{
  const store=await make(path);await ready(store);const pending=structuredClone(send.command);pending.commandId='unfinished-large-transfer';if('text' in pending.request.payload)pending.request.payload.text='x'.repeat(9000);await rehash(pending);
  const unfinished=await chunks(pending);await store.stageChunk(unfinished.chunks[0]);const originals:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]=[];
  for(let i=0;i<130;i++){
    await store.heartbeat();const command=structuredClone(send.command);command.commandId='completed-transfer-'+i;command.action='RECONCILE';await rehash(command);const t=await chunks(command);
    for(const item of t.chunks)await store.stageChunk(item);await store.commitCommand(t.commit);assert.deepEqual(await store.takeForDispatch(),command);
    const result=await resultFor(command,send.result);await store.recordIncoming(result,pins);originals.push({command,result});
  }
  await store.disconnect();assert.ok(peerModule);const reopened=new peerModule.RbridgeChatPeerStoreV3(path);await ready(reopened);
  const first=originals[0]!,t=await chunks(first.command);for(const item of t.chunks)await reopened.stageChunk(item);await reopened.commitCommand(t.commit);
  assert.equal(await reopened.takeForDispatch(),null);assert.deepEqual((await reopened.read(first.command.commandId,scope)).result,first.result);
  const altered=structuredClone(t.chunks[0]!);const bytes=Buffer.from(altered.dataBase64,'base64');bytes[0]=bytes[0]!^1;altered.dataBase64=bytes.toString('base64');await assert.rejects(()=>reopened.stageChunk(altered),/COLLISION/);
  await assert.rejects(()=>reopened.commitCommand(unfinished.commit),/PARTIAL_COMMAND_UNCERTAIN/);
  const journal=JSON.parse(await readFile(join(path,'v3-peer','journal.json'),'utf8')) as {transfers:{commit:Commit;chunks:(string|null)[]}[];commands:unknown[]};
  assert.equal(journal.transfers.length,1);assert.equal(journal.transfers[0]?.commit.commandId,pending.commandId);assert.equal(journal.transfers[0]?.chunks[0],unfinished.chunks[0]?.dataBase64);assert.equal(journal.commands.length,130);
}));

console.log(JSON.stringify({suite:'W1_V3_FIXED_PEER',passed,failed,skipped,installedForcedCommand:'NOT_RUN',brokerTransport:'NOT_IMPLEMENTED_IN_THIS_INCREMENT',liveAcceptance:'NOT_RUN'}));
if(failed)process.exitCode=1;
