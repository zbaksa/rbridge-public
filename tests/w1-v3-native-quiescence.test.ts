import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as protocol from '../src/nativeHost/nativeHostProtocol.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {NativeHostRuntimeV1} from '../src/nativeHost/nativeHostRuntime.js';
import {NativeV3PeerAuthority} from '../src/nativeHost/nativeV3PeerAuthority.js';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {RbridgeEventSpoolV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalDigest,V3_CAPABILITIES,type V3Scope,type VerifiedPeerV3,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1} from '../src/domain/rbridgeEffectProtocol.js';
import {RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY,buildScopeStopRequest,buildScopeQuiescenceQuery,buildScopeResultInventory,buildWorkerQuiescenceReport,parseNativeQuiescenceReport,type RbridgeScopeQuiescenceQueryV1,type RbridgeScopeEventHeadV1,type WorkerQuiescenceFactsV1} from '../src/domain/rbridgeScopeQuiescence.js';
import {NativeMessageDecoder,encodeNativeMessage} from '../src/transport/nativeMessaging.js';
import {StdioFrameDecoder,encodeStdioFrame} from '../src/transport/sshStdio.js';
import type {SshProcessHandleV1} from '../src/nativeHost/persistentSshSession.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!,send=fixture.vectors[1]!,target=bind.command.request.payload.target;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
const pins:VerifiedPeerV3={peerId:'native-quiescence-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES,RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY]};
const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:pins.releaseSha,browserInstanceId:pins.browserInstanceId,browserProfileId:pins.browserProfileId,maxMessageBytes:pins.maxMessageBytes,capabilities:[...pins.capabilities],nativeHostVersion:'fixture-native'};
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function root(){const p=await realpath(await mkdtemp(join(tmpdir(),'rbridge-native-quiescence-')));roots.push(p);return p;}
async function query(id='native-query',current=scope,peer=pins,submittedAt=Date.now()){
  const request=await buildScopeStopRequest({requestId:'native-stop',scope:current,challenge:'c'.repeat(64),issuedAt:new Date().toISOString()});
  return buildScopeQuiescenceQuery({queryId:id,queryNonce:'d'.repeat(64),request,channelId:'a'.repeat(32),peerPinsSha256:await canonicalDigest(peer),submittedAt});
}
async function worker(q:RbridgeScopeQuiescenceQueryV1,extra:Partial<WorkerQuiescenceFactsV1>={}){
  const fenceBody={schema:'RBRIDGE_SCOPE_STOP_FENCE_V1' as const,state:'STOP_REQUESTED' as const,request:q.request,recordedAt:new Date().toISOString()};
  return buildWorkerQuiescenceReport(q,{fence:{...fenceBody,sha256:await canonicalDigest(fenceBody)},sealed:true,captureStopped:true,pendingHandlers:0,pendingReaders:0,pendingEgress:0,unresolvedCaptureCount:0,resultInventory:await buildScopeResultInventory({scope:q.request.scope,entryCount:0,unresolvedCount:0,entriesSha256:await canonicalDigest([])}),eventHead:{sequence:0,eventSha256:null},observedAt:new Date().toISOString(),...extra});
}
async function make(options:{capability?:boolean;privatePins?:boolean}={}){
  const path=await root(),configuredPins=options.capability===false?{...pins,capabilities:[...V3_CAPABILITIES]}:pins;
  const localHello={...hello,capabilities:[...configuredPins.capabilities]};
  const events=new RbridgeChatEventStoreV1({root:path});await events.load();
  const results=new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope,maxMessageBytes:65536});
  const authority=new NativeV3PeerAuthority({eventStoreRoot:path,appId:scope.appId,peerPins:configuredPins,initialHistory:{sequence:0,eventSha256:null}});
  const messages:unknown[]=[],optionsV3={results,authority,scope,...(options.privatePins===false?{}:{peerPins:configuredPins})};
  const relay=new NativeHostRelayV1(events,{send:async value=>{messages.push(structuredClone(value));}},optionsV3);
  await relay.acceptBrowserMessage(localHello);await relay.peerConnected();await relay.acceptServerMessage(localHello);
  return {path,events,results,relay,messages,hello:localHello};
}
async function event(){return new RbridgeEventSpoolV1().append({eventId:'native-quiescence-event',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:new Date().toISOString(),payload:{reason:'TAB_CLOSED'}});}
async function browserRoute(input:unknown,q:RbridgeScopeQuiescenceQueryV1){
  const route=(protocol as unknown as {routeBrowserToNativeV3?:(input:unknown,maxBytes:number,query?:RbridgeScopeQuiescenceQueryV1)=>Promise<{kind:string;value:unknown}>}).routeBrowserToNativeV3;
  expect(typeof route,'missing strict V3 browser report router').toBe('function');return route!(input,65536,q);
}
async function head(events:RbridgeChatEventStoreV1){
  const read=(events as unknown as {readDurableHead?:()=>Promise<RbridgeScopeEventHeadV1>}).readDurableHead;
  expect(typeof read,'missing independent durable event head readback').toBe('function');return read!.call(events);
}
async function sign<T extends {sha256:string}>(value:T):Promise<T>{const {sha256,...body}=value;void sha256;return {...body,sha256:await canonicalDigest(body)} as T;}

describe('Native scope quiescence observations',()=>{
  it('routes a strict standalone query without a V1 command or effect reservation',async()=>{
    const q=await query();expect(await protocol.routeServerToNativeV3(q,65536)).toEqual({kind:'SCOPE_QUIESCENCE_QUERY',value:q});
    expect(()=>protocol.routeServerToNative(q)).toThrow();
  });
  it('routes a worker report only with its complete correlated original query',async()=>{
    const q=await query(),report=await worker(q);expect(await browserRoute(report,q)).toEqual({kind:'WORKER_QUIESCENCE_REPORT',value:report});
    await expect(protocol.routeBrowserToNative(report)).rejects.toThrow();
  });
  it('admits qualified query facts without reserving synthetic effects or changing history',async()=>{
    const h=await make(),q=await query(),before=await readFile(join(h.path,'v3-peer-owner.json'));
    expect((await h.relay.acceptServerMessage(q)).message.value).toEqual(q);
    await expect(readFile(join(h.path,'v3-results','journal.json'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(join(h.path,'v3-peer-owner.json'))).toEqual(before);
  });
  it('rejects unsupported capability rather than interpreting an old peer as drained',async()=>{
    const h=await make({capability:false});await expect(h.relay.acceptServerMessage(await query('unsupported',scope,{...pins,capabilities:[...V3_CAPABILITIES]}))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY_REQUIRED');
  });
  it('requires configured private pins instead of HELLO claims',async()=>{
    const h=await make({privatePins:false});await expect(h.relay.acceptServerMessage(await query())).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_CONFIG_REQUIRED');
  });
  it('rejects private pin and configured scope mismatches before browser output',async()=>{
    const h=await make();await h.relay.acceptServerMessage(await query());
    await expect(h.relay.acceptServerMessage(await query('bad-pins',scope,{...pins,peerId:'foreign'}))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_PIN_MISMATCH');
    await expect(h.relay.acceptServerMessage(await query('bad-scope',{...scope,baseSha:'f'.repeat(40)}))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_SCOPE_MISMATCH');
  });
  it('retains exact query identity and rejects changed nonce under the same ID',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);expect((await h.relay.acceptServerMessage(q)).message.value).toEqual(q);
    const body={queryId:q.queryId,queryNonce:'e'.repeat(64),request:q.request,channelId:q.channelId,peerPinsSha256:q.peerPinsSha256,submittedAt:q.submittedAt};
    await expect(h.relay.acceptServerMessage(await buildScopeQuiescenceQuery(body))).rejects.toThrow('REQUEST_ID_COLLISION');
  });
  it('attaches actual null reservations as generic factual inventory without PASS',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);await h.results.reserve(send.command);
    expect(await h.relay.acceptBrowserMessage(await worker(q))).toBe('QUIESCENCE_REPORT_FORWARDED');
    const report=await parseNativeQuiescenceReport(h.messages.at(-1),q);
    expect(report.resultInventory).toMatchObject({schema:'RBRIDGE_SCOPE_RESULT_INVENTORY_V1',scope,entryCount:1,unresolvedCount:1});
    expect(report.eventHead).toEqual({sequence:0,eventSha256:null});expect('status' in report).toBe(false);
    expect((await h.results.read(send.command.commandId))?.result).toBeNull();
  });
  it('processes all earlier browser events and results before observing its report',async()=>{
    const h=await make(),q=await query(),original=await event();await h.relay.acceptServerMessage(bind.command);await h.relay.acceptServerMessage(q);
    const before=await readFile(join(h.path,'v3-peer-owner.json')),first=h.relay.acceptBrowserMessage(original),second=h.relay.acceptBrowserMessage(bind.result),third=h.relay.acceptBrowserMessage(await worker(q,{eventHead:{sequence:1,eventSha256:original.eventSha256}}));
    await Promise.all([first,second,third]);const report=await parseNativeQuiescenceReport(h.messages.at(-1),q);
    expect(report.resultInventory).toMatchObject({entryCount:1,unresolvedCount:0});expect(report.eventHead).toEqual({sequence:1,eventSha256:original.eventSha256});
    expect(h.messages.slice(-3).map(v=>(v as {schema:string}).schema)).toEqual(['RBRIDGE_CHAT_EVENT_V1','RBRIDGE_CHAT_EFFECT_RESULT_V1','RBRIDGE_SCOPE_QUIESCENCE_NATIVE_V1']);
    expect(await readFile(join(h.path,'v3-peer-owner.json'))).toEqual(before);
  });
  it('rejects unsolicited reports and different query hashes without authority',async()=>{
    const h=await make(),q=await query();await expect(h.relay.acceptBrowserMessage(await worker(q))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_QUERY_REQUIRED');
    await h.relay.acceptServerMessage(q);await expect(h.relay.acceptBrowserMessage(await worker(await query('never-issued')))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_QUERY_REQUIRED');
  });
  it('rejects rehashed worker fence requests that differ from the original STOP',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);const report=await worker(q),alteredRequest=await buildScopeStopRequest({requestId:q.request.requestId,scope:q.request.scope,challenge:'e'.repeat(64),issuedAt:q.request.issuedAt});
    const fence=await sign({...report.fence,request:alteredRequest});await expect(h.relay.acceptBrowserMessage(await sign({...report,fence}))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_REQUEST_MISMATCH');
  });
  it('rejects expiration at report receipt while retaining original result bytes',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);await h.results.reserve(send.command);const before=await readFile(join(h.path,'v3-results','journal.json')),report=await worker(q);
    vi.spyOn(Date,'now').mockReturnValue(q.expiresAt);await expect(h.relay.acceptBrowserMessage(report)).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_STALE');expect(await readFile(join(h.path,'v3-results','journal.json'))).toEqual(before);
  });
  it('invalidates pending control on disconnect and never adopts its old report after reconnect',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);h.relay.peerDisconnected();await h.relay.peerConnected();await h.relay.acceptServerMessage(h.hello);
    await expect(h.relay.acceptBrowserMessage(await worker(q))).rejects.toThrow('RBRIDGE_PEER_CONNECTION_CHANGED');
    await expect(h.relay.acceptServerMessage(q)).rejects.toThrow('RBRIDGE_PEER_CONNECTION_CHANGED');
  });
  it('invalidates pending control when a new HELLO replaces negotiation',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);await h.relay.acceptBrowserMessage(h.hello);await h.relay.acceptServerMessage(h.hello);
    await expect(h.relay.acceptBrowserMessage(await worker(q))).rejects.toThrow('RBRIDGE_PEER_CONNECTION_CHANGED');
  });
  it('rechecks epoch after actual retained inventory readback',async()=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);const report=await worker(q),read=h.results.readScopeInventory.bind(h.results),before=h.messages.length;
    vi.spyOn(h.results,'readScopeInventory').mockImplementation(async current=>{const value=await read(current);h.relay.peerDisconnected();return value;});
    await expect(h.relay.acceptBrowserMessage(report)).rejects.toThrow('RBRIDGE_PEER_CONNECTION_CHANGED');expect(h.messages.length).toBe(before);
  });
  it('bounds retained pending controls without deleting earlier identities',async()=>{
    const h=await make();for(let i=0;i<128;i++)await h.relay.acceptServerMessage(await query('bound-'+i));
    await expect(h.relay.acceptServerMessage(await query('bound-overflow'))).rejects.toThrow('RBRIDGE_SCOPE_QUIESCENCE_PENDING_LIMIT');
    await expect(readFile(join(h.path,'v3-results','journal.json'))).rejects.toMatchObject({code:'ENOENT'});
  },15000);
  it('retains immutable query and worker bytes across queued asynchronous parsing',async()=>{
    const h=await make(),q=await query(),original=structuredClone(q),accept=h.relay.acceptServerMessage(q);q.queryNonce='e'.repeat(64);expect((await accept).message.value).toEqual(original);
    const report=await worker(original),expected=structuredClone(report),pending=h.relay.acceptBrowserMessage(report);report.pendingHandlers=1;await pending;
    expect((await parseNativeQuiescenceReport(h.messages.at(-1),original)).worker).toEqual(expected);
  });
  it('reads durable event head through the append gate and rejects cached-but-corrupt disk history',async()=>{
    const path=await root(),events=new RbridgeChatEventStoreV1({root:path}),original=await event(),append=events.append(original),read=head(events);const [,observed]=await Promise.all([append,read]);
    expect(observed).toEqual({sequence:1,eventSha256:original.eventSha256});const originalBytes=await readFile(join(path,'events.ndjson'));
    expect(await head(events)).toEqual({sequence:1,eventSha256:original.eventSha256});expect(await readFile(join(path,'events.ndjson'))).toEqual(originalBytes);
    await writeFile(join(path,'events.ndjson'),'{}\n',{mode:0o600});expect(await events.load()).toEqual([original]);await expect(head(events)).rejects.toThrow();
    await writeFile(join(path,'events.ndjson'),originalBytes);await unlink(join(path,'events.ndjson'));await expect(head(events)).rejects.toThrow('RBRIDGE_EVENT_STORE_READBACK_MISMATCH');
  });
});

class FakeSsh implements SshProcessHandleV1 {
  writes:Uint8Array[]=[];killed=false;private data:(bytes:Uint8Array)=>void=()=>{};
  write(bytes:Uint8Array){this.writes.push(bytes);}onData(fn:(bytes:Uint8Array)=>void){this.data=fn;}
  onClose(_fn:(code:number|null,signal:string|null)=>void){void _fn;}onError(_fn:(error:Error)=>void){void _fn;}kill(){this.killed=true;}
  emit(value:unknown){this.data(encodeStdioFrame(value));}
}
async function until(fn:()=>boolean){for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}expect(fn(),'bounded Native frame observation').toBe(true);}
it('carries exact raw query/report framing and configured pins through Native runtime',async()=>{
  const path=await root(),ssh=new FakeSsh(),output:Uint8Array[]=[],errors:string[]=[],config={expectedExtensionId:'a'.repeat(32),eventStoreRoot:path,ssh:{sshPath:join(path,'ssh'),host:'aether-engine',port:22,user:'rbridge' as const,identityFile:join(path,'id'),knownHostsFile:join(path,'known-hosts')},v3:{scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}}};
  const host=new NativeHostRuntimeV1(config,{write:bytes=>{output.push(bytes);}},{onProtocolError:e=>{errors.push(e.message);}},{processFactory:{launch:()=>ssh},scheduler:{set:()=>null,clear:()=>{}}});
  try{host.start(['chrome-extension://'+'a'.repeat(32)+'/']);await host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>ssh.writes.length===1);ssh.emit(hello);await until(()=>output.length===1||errors.length>0);expect(errors).toEqual([]);
    const q=await query();ssh.emit(q);await until(()=>output.length===2||errors.length>0);expect(errors).toEqual([]);expect(new NativeMessageDecoder().push(output[1]!)).toEqual([q]);
    await host.acceptNativeChunk(encodeNativeMessage(await worker(q)));const frames=new StdioFrameDecoder().push(ssh.writes.at(-1)!);expect(frames).toHaveLength(1);const report=await parseNativeQuiescenceReport(frames[0],q);expect(report.resultInventory.entryCount).toBe(0);expect(report.eventHead.sequence).toBe(0);expect('kind' in (frames[0] as object)).toBe(false);
  }finally{host.stop();}
});

it.each(['connection','expiry'] as const)('fences a validated query when %s changes before Runtime output',async kind=>{
  const path=await root(),ssh=new FakeSsh(),output:Uint8Array[]=[],errors:string[]=[],config={expectedExtensionId:'a'.repeat(32),eventStoreRoot:path,ssh:{sshPath:join(path,'ssh'),host:'aether-engine',port:22,user:'rbridge' as const,identityFile:join(path,'id'),knownHostsFile:join(path,'known-hosts')},v3:{scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}}};
  const host=new NativeHostRuntimeV1(config,{write:bytes=>{output.push(bytes);}},{onProtocolError:e=>{errors.push(e.message);}},{processFactory:{launch:()=>ssh},scheduler:{set:()=>null,clear:()=>{}}});
  try{
    host.start(['chrome-extension://'+'a'.repeat(32)+'/']);await host.acceptNativeChunk(encodeNativeMessage(hello));await until(()=>ssh.writes.length===1);ssh.emit(hello);await until(()=>output.length===1||errors.length>0);expect(errors).toEqual([]);
    const relay=(host as unknown as {relay:NativeHostRelayV1}).relay,accept=relay.acceptServerMessage.bind(relay);
    vi.spyOn(relay,'acceptServerMessage').mockImplementation(async value=>{
      const accepted=await accept(value);
      if(accepted.message.kind==='SCOPE_QUIESCENCE_QUERY'){
        if(kind==='connection'){relay.peerDisconnected();await relay.peerConnected();await accept(hello);}else vi.spyOn(Date,'now').mockReturnValue(accepted.message.value.expiresAt);
      }
      return accepted;
    });
    ssh.emit(await query());await until(()=>output.length>1||errors.length>0);
    expect(errors).toContain(kind==='connection'?'RBRIDGE_PEER_CONNECTION_CHANGED':'RBRIDGE_SCOPE_QUIESCENCE_STALE');expect(output).toHaveLength(1);
  }finally{host.stop();}
});

for(const cached of [false,true]){
  it.each(['connection','expiry'] as const)('fences '+(cached?'cached':'fresh')+' native report when %s changes after final asynchronous check',async kind=>{
    const h=await make(),q=await query();await h.relay.acceptServerMessage(q);const report=await worker(q);
    if(cached)await h.relay.acceptBrowserMessage(report);
    const before=h.messages.length,gate=h.relay as unknown as {currentQuiescence:(query:RbridgeScopeQuiescenceQueryV1,epoch:number,negotiated:unknown)=>Promise<void>},check=gate.currentQuiescence.bind(h.relay);
    let checks=0;
    vi.spyOn(gate,'currentQuiescence').mockImplementation(async(...args)=>{
      await check(...args);
      if(++checks===2){
        if(kind==='connection')h.relay.peerDisconnected();else vi.spyOn(Date,'now').mockReturnValue(q.expiresAt);
      }
    });
    await expect(h.relay.acceptBrowserMessage(report)).rejects.toThrow(kind==='connection'?'RBRIDGE_PEER_CONNECTION_CHANGED':'RBRIDGE_SCOPE_QUIESCENCE_STALE');
    expect(checks).toBe(2);expect(h.messages).toHaveLength(before);
  });
}
