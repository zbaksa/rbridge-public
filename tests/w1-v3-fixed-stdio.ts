import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {RbridgeChatPeerStoreV3} from '../src/server/rbridgeChatPeerStore.js';
import {encodeStdioFrame,StdioFrameDecoder} from '../src/transport/sshStdio.js';
import {REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalJson,sha256Hex,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope,type VerifiedPeerV3} from '../src/domain/rbridgeEffectProtocol.js';

const stdioPath='../src/server/rbridgeChatStdio.js',cliPath='../src/server/rbridgeChatPeerCli.js';
const stdioModule=await import(stdioPath).catch(()=>null) as {runRbridgeChatStdio(input:NodeJS.ReadableStream,output:NodeJS.WritableStream,store:RbridgeChatPeerStoreV3):Promise<void>}|null;
const cliModule=await import(cliPath).catch(()=>null) as {executeRbridgeChatPeerCli(store:RbridgeChatPeerStoreV3,args:readonly string[]):Promise<{schema:string;status:string;operation:string;value:unknown}>}|null;
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
const target=bind.command.request.payload.target;
const pins:VerifiedPeerV3={peerId:'fixed-rbridge-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES,'CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2']};
const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:pins.releaseSha,browserInstanceId:pins.browserInstanceId,browserProfileId:pins.browserProfileId,maxMessageBytes:pins.maxMessageBytes,capabilities:[...pins.capabilities],nativeHostVersion:'1.0.0'};
const activeChannels=new Set<{input:PassThrough;output:Writable;run:Promise<void>}>();
async function fixtureRoot(fn:(store:RbridgeChatPeerStoreV3,path:string)=>Promise<void>){const path=await realpath(await mkdtemp(join(tmpdir(),'rbridge-fixed-stdio-')));try{await writeFile(join(path,'v3-peer-config.json'),canonicalJson({schema:'RBRIDGE_CHAT_PEER_CONFIG_V3',scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}})+'\n',{mode:0o600});await fn(new RbridgeChatPeerStoreV3(path),path);}finally{const active=[...activeChannels];for(const c of active){c.input.destroy();c.output.destroy();}await Promise.allSettled(active.map(c=>c.run));activeChannels.clear();await rm(path,{recursive:true,force:true});}}
async function until(fn:()=>boolean|Promise<boolean>,timeout=2000){const end=Date.now()+timeout;while(!await fn()){if(Date.now()>end)assert.fail('FIXED_STDIO_CONDITION_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}}
function channels(store:RbridgeChatPeerStoreV3){assert.ok(stdioModule,'FIXED_STDIO_NOT_IMPLEMENTED');const input=new PassThrough(),output=new PassThrough(),messages:unknown[]=[],decoder=new StdioFrameDecoder();output.on('data',(data:Buffer)=>messages.push(...decoder.push(data)));const run=stdioModule.runRbridgeChatStdio(input,output,store);void run.catch(()=>undefined);activeChannels.add({input,output,run});return {input,output,messages,run};}
async function helloChannel(store:RbridgeChatPeerStoreV3){const c=channels(store);c.input.write(encodeStdioFrame(hello));await until(()=>c.messages.length===1);assert.deepEqual(c.messages[0],hello);return c;}
const encoded=(value:unknown)=>Buffer.from(canonicalJson(value)).toString('base64');
async function transfer(command:RbridgeChatEffectCommandV1){const bytes=Buffer.from(canonicalJson(command));const commit={schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1',commandId:command.commandId,commandSha256:command.commandSha256,requestDigest:command.request.requestDigest,transferSha256:await sha256Hex(bytes),totalBytes:bytes.length,chunkCount:Math.ceil(bytes.length/3072)};const chunks=Array.from({length:commit.chunkCount},(_,index)=>({...commit,schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1',index,offset:index*3072,dataBase64:bytes.subarray(index*3072,Math.min((index+1)*3072,bytes.length)).toString('base64')}));return {commit,chunks};}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_FIXED_STDIO '+name);}catch(e){failed++;console.error('FAIL V3_FIXED_STDIO '+name+': '+String(e));}}

await test('incoming_effect_before_pinned_hello_is_rejected',()=>fixtureRoot(async store=>{
 const c=channels(store);c.input.end(encodeStdioFrame(bind.command));await assert.rejects(c.run,/HELLO_REQUIRED/);assert.deepEqual(c.messages,[]);await assert.rejects(()=>store.peer(),/NOT_NEGOTIATED|UNAVAILABLE/);
}));
await test('fragmented_hello_precedes_complete_command_dispatch',()=>fixtureRoot(async(store,path)=>{
 const c=channels(store),frame=encodeStdioFrame(hello);c.input.write(frame.subarray(0,7));await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(c.messages,[]);c.input.write(frame.subarray(7));await until(()=>c.messages.length===1);assert.deepEqual(c.messages[0],hello);
 const broker=new RbridgeChatPeerStoreV3(path);await broker.enqueue(bind.command,scope);await until(()=>c.messages.length===2);assert.deepEqual(c.messages[1],bind.command);
 c.input.write(encodeStdioFrame(bind.result));await until(async()=>Boolean((await broker.read(bind.command.commandId,scope)).result));assert.deepEqual((await broker.read(bind.command.commandId,scope)).result,bind.result);c.input.end();await c.run;await assert.rejects(()=>broker.peer(),/NOT_NEGOTIATED|UNAVAILABLE/);
}));
await test('disconnect_mid_frame_preserves_dispatched_uncertainty',()=>fixtureRoot(async(store,path)=>{
 const c=await helloChannel(store);await store.enqueue(bind.command,scope);await until(()=>c.messages.length===2);const frame=encodeStdioFrame(bind.result);c.input.end(frame.subarray(0,frame.length-3));await assert.rejects(c.run,/INCOMPLETE/);
 const next=new RbridgeChatPeerStoreV3(path);await next.recordIncoming(hello,pins);assert.equal(await next.takeForDispatch(),null);assert.equal((await next.read(bind.command.commandId,scope)).result,null);await next.disconnect();
}));
await test('wrong_release_hello_cannot_publish_peer',()=>fixtureRoot(async store=>{
 const c=channels(store);c.input.end(encodeStdioFrame({...hello,releaseSha:'2'.repeat(40)}));await assert.rejects(c.run,/PIN|PEER/);assert.deepEqual(c.messages,[]);await assert.rejects(()=>store.peer(),/NOT_NEGOTIATED|UNAVAILABLE/);
}));
await test('output_failure_never_blindly_resends_dispatched_command',()=>fixtureRoot(async(store,path)=>{
 assert.ok(stdioModule,'FIXED_STDIO_NOT_IMPLEMENTED');const input=new PassThrough();let writes=0;const output=new Writable({write(_data,_encoding,callback){writes++;callback(writes===2?Error('OUTPUT_DISCONNECTED'):undefined);}});output.on('error',()=>undefined);const run=stdioModule.runRbridgeChatStdio(input,output,store);void run.catch(()=>undefined);activeChannels.add({input,output,run});input.write(encodeStdioFrame(hello));await until(()=>writes===1);await store.enqueue(bind.command,scope);await assert.rejects(run,/OUTPUT_DISCONNECTED/);
 const next=new RbridgeChatPeerStoreV3(path);await next.recordIncoming(hello,pins);assert.equal(await next.takeForDispatch(),null);await next.disconnect();input.destroy();
}));
await test('result_and_event_are_durable_before_channel_closes',()=>fixtureRoot(async(store,path)=>{
 const c=await helloChannel(store);await store.enqueue(bind.command,scope);await until(()=>c.messages.length===2);const event=await new RbridgeEventSpoolV1().append({eventId:'fixed-stdio-event-1',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:'2026-10-02T12:00:00.000Z',payload:{reason:'UI_PROTOCOL_CHANGED'}});c.input.end(Buffer.concat([encodeStdioFrame(event),encodeStdioFrame(bind.result)]));await c.run;
 const next=new RbridgeChatPeerStoreV3(path);await next.recordIncoming(hello,pins);assert.deepEqual(await next.readEvent(0),event);assert.deepEqual((await next.read(bind.command.commandId,scope)).result,bind.result);await next.disconnect();
}));
await test('duplicate_hello_cannot_reset_existing_channel',()=>fixtureRoot(async store=>{
 const c=await helloChannel(store);c.input.end(encodeStdioFrame(hello));await assert.rejects(c.run,/HELLO_DUPLICATE/);assert.equal(c.messages.length,1);
}));
await test('live_stdio_heartbeats_beyond_peer_lease',()=>fixtureRoot(async store=>{
 const c=await helloChannel(store);await new Promise(resolve=>setTimeout(resolve,5200));assert.deepEqual(await store.peer(),pins);c.input.end();await c.run;
}));
await test('cli_immutable_chunks_only_enqueue_after_complete_commit',()=>fixtureRoot(async(store,path)=>{
 assert.ok(cliModule,'FIXED_PEER_CLI_NOT_IMPLEMENTED');await store.recordIncoming(hello,pins);const broker=new RbridgeChatPeerStoreV3(path),t=await transfer(bind.command);
 for(const chunk of t.chunks){const arg=encoded(chunk);assert.ok(Buffer.byteLength(arg)<8192);const value=await cliModule.executeRbridgeChatPeerCli(broker,['stage-chunk',arg]);assert.equal(value.status,'PASS');assert.equal(await store.takeForDispatch(),null);}
 const value=await cliModule.executeRbridgeChatPeerCli(broker,['commit-command',encoded(t.commit)]);assert.equal(value.status,'PASS');assert.deepEqual(await store.takeForDispatch(),bind.command);await store.disconnect();
}));
await test('cli_reads_original_result_without_unbounded_event_bundle',()=>fixtureRoot(async store=>{
 assert.ok(cliModule,'FIXED_PEER_CLI_NOT_IMPLEMENTED');await store.recordIncoming(hello,pins);await store.enqueue(bind.command,scope);await store.takeForDispatch();await store.recordIncoming(bind.result,pins);
 const value=await cliModule.executeRbridgeChatPeerCli(store,['read-result',encoded({commandId:bind.command.commandId,scope})]);assert.deepEqual(value,{schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3',status:'PASS',operation:'read-result',value:bind.result});assert.equal(await store.takeForDispatch(),null);await store.disconnect();
}));
await test('cli_rejects_command_paths_and_extra_fields',()=>fixtureRoot(async store=>{
 assert.ok(cliModule,'FIXED_PEER_CLI_NOT_IMPLEMENTED');await store.recordIncoming(hello,pins);
 for(const args of [['run','/bin/sh'],['inspect-peer',encoded({}),'/other/root'],['inspect-peer',encoded({host:'unapproved'})],['read-result',encoded({commandId:bind.command.commandId,scope,root:'/foreign'})],['read-event',encoded({afterSequence:0,path:'/foreign'})]])await assert.rejects(()=>cliModule.executeRbridgeChatPeerCli(store,args),/CLI|FIELDS/);
 assert.deepEqual(await store.peer(),pins);await store.disconnect();
}));
await test('cli_rejects_noncanonical_base64_and_oversized_argument',()=>fixtureRoot(async store=>{
 assert.ok(cliModule,'FIXED_PEER_CLI_NOT_IMPLEMENTED');await store.recordIncoming(hello,pins);
 for(const arg of [encoded({})+'\n','a'.repeat(8193),Buffer.from([255,254]).toString('base64'),''])await assert.rejects(()=>cliModule.executeRbridgeChatPeerCli(store,['inspect-peer',arg]),/CLI/);
 assert.equal(await store.takeForDispatch(),null);await store.disconnect();
}));
await test('cli_inspect_and_single_event_read_require_live_pinned_channel',()=>fixtureRoot(async store=>{
 assert.ok(cliModule,'FIXED_PEER_CLI_NOT_IMPLEMENTED');await assert.rejects(()=>cliModule.executeRbridgeChatPeerCli(store,['inspect-peer',encoded({})]),/NOT_NEGOTIATED|UNAVAILABLE/);await store.recordIncoming(hello,pins);
 assert.deepEqual((await cliModule.executeRbridgeChatPeerCli(store,['inspect-peer',encoded({})])).value,pins);assert.equal((await cliModule.executeRbridgeChatPeerCli(store,['read-event',encoded({afterSequence:0})])).value,null);await store.disconnect();
}));
console.log(JSON.stringify({suite:'W1_V3_FIXED_STDIO',passed,failed,installedForcedCommand:'NOT_RUN',liveAcceptance:'NOT_RUN'}));if(failed)process.exitCode=1;
