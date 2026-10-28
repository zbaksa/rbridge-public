import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {RbridgeChatPeerStoreV3} from '../src/server/rbridgeChatPeerStore.js';
import {executeRbridgeChatPeerCli} from '../src/server/rbridgeChatPeerCli.js';
import {runRbridgeChatStdio} from '../src/server/rbridgeChatStdio.js';
import {buildCommandResultV1,type RbridgeChatCommandV1,type RbridgeChatCommandResultV1} from '../src/domain/rbridgeChatCommand.js';
import {canonicalDigest,canonicalJson,V3_CAPABILITIES,type V3Scope,type VerifiedPeerV3,type RbridgeChatEffectCommandV1} from '../src/domain/rbridgeEffectProtocol.js';
import {RbridgeEventSpoolV1,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {encodeStdioFrame,StdioFrameDecoder} from '../src/transport/sshStdio.js';

interface Query {scope:V3Scope;command:RbridgeChatCommandV1}
interface RecordV1 extends Query {schema:'RBRIDGE_CHAT_READ_QUERY_RECORD_V1';channelId:string;submittedAt:number;expiresAt:number;state:'QUEUED'|'DISPATCHED'|'COMPLETE';result:RbridgeChatCommandResultV1|null;receivedAt:number|null}
interface ReadStore {submitReadQuery(query:Query):Promise<RecordV1>;readQuery(commandId:string,scope:V3Scope):Promise<RecordV1|null>}
interface QueryModule {buildRbridgeReadQuery(scope:V3Scope,action:'READ_STATE'|'DISCOVER_TARGET',payload:Record<string,unknown>,commandId:string,issuedAt:string):Promise<Query>;parseRbridgeReadQuery(input:unknown):Promise<Query>;parseRbridgeReadQueryRecord(input:unknown):Promise<RecordV1>}
const modulePath='../src/domain/rbridgeReadQuery.js';
const queryModule=await import(modulePath).catch(()=>null) as QueryModule|null;
const fixture=JSON.parse(await readFile(new URL('./fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1}[]};
const effect=fixture.vectors[0]!.command,target=effect.request.payload.target;
const scope:V3Scope={appId:effect.request.appId,baseSha:effect.request.baseSha,sessionId:effect.request.sessionId,generation:effect.request.generation};
const pins:VerifiedPeerV3={peerId:'query-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES]};
const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha:pins.releaseSha,browserInstanceId:pins.browserInstanceId,browserProfileId:pins.browserProfileId,maxMessageBytes:pins.maxMessageBytes,capabilities:pins.capabilities,nativeHostVersion:'1.0.0'};
const encoded=(v:unknown)=>Buffer.from(canonicalJson(v)).toString('base64');
async function query(id='read-1',action:'READ_STATE'|'DISCOVER_TARGET'='READ_STATE',current=scope):Promise<Query>{
  const command={schema:'RBRIDGE_CHAT_COMMAND_V1' as const,commandId:id,action,sessionId:current.sessionId,generation:current.generation,attemptId:null,effectId:null,issuedAt:'2026-10-28T12:00:00.000Z',payload:action==='READ_STATE'?{}:{canonicalProjectId:target.canonicalProjectId,conversationId:target.conversationId}};
  return {scope:structuredClone(current),command:{...command,requestDigest:await canonicalDigest({schema:'RBRIDGE_CHAT_READ_QUERY_DIGEST_V1',scope:current,command})}};
}
function reads(store:RbridgeChatPeerStoreV3):ReadStore{return store as unknown as ReadStore;}
async function root(fn:(store:RbridgeChatPeerStoreV3,path:string)=>Promise<void>){
  const path=await realpath(await mkdtemp(join(tmpdir(),'rbridge-read-query-')));
  const store=new RbridgeChatPeerStoreV3(path);
  try{await writeFile(join(path,'v3-peer-config.json'),canonicalJson({schema:'RBRIDGE_CHAT_PEER_CONFIG_V3',scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}})+'\n',{mode:0o600});await store.acceptHello(hello);await fn(store,path);}
  finally{await store.disconnect().catch(()=>undefined);await rm(path,{recursive:true,force:true});}
}
async function resultFor(q:Query,result:unknown={observed:'stored-state'}){return buildCommandResultV1(q.command,{ok:true,result});}
async function file(path:string){return readFile(path).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});}
async function transfer(command:RbridgeChatEffectCommandV1){
  const bytes=Buffer.from(canonicalJson(command)),commit={schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1',commandId:command.commandId,commandSha256:command.commandSha256,requestDigest:command.request.requestDigest,transferSha256:await canonicalDigest(command),totalBytes:bytes.length,chunkCount:Math.ceil(bytes.length/3072)};
  return {...commit,schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1',index:0,offset:0,dataBase64:bytes.subarray(0,3072).toString('base64')};
}
afterEach(()=>vi.restoreAllMocks());

describe('existing owner read commands through the fixed V3 peer',()=>{
  it.each(['READ_STATE','DISCOVER_TARGET'] as const)('CLI dispatches %s and records an exact correlated result',action=>root(async(store,path)=>{
    const q=await query('cli-'+action,action),broker=new RbridgeChatPeerStoreV3(path);
    const submitted=(await executeRbridgeChatPeerCli(broker,['submit-query',encoded(q)])).value as RecordV1;
    expect(submitted.state).toBe('QUEUED');expect(submitted.expiresAt-submitted.submittedAt).toBe(5000);expect(submitted.command).toEqual(q.command);
    expect(await store.takeForDispatch()).toEqual(q.command);
    const result=await resultFor(q);await store.recordIncoming(result,pins);
    const completed=(await executeRbridgeChatPeerCli(broker,['read-query',encoded({commandId:q.command.commandId,scope})])).value as RecordV1;
    expect(completed).toMatchObject({state:'COMPLETE',result,channelId:submitted.channelId});expect(completed.receivedAt).toBeGreaterThanOrEqual(submitted.submittedAt);
  }));
  it('requires a live pinned channel and exact configured scope',()=>root(async(store,path)=>{
    const q=await query();await store.disconnect();await expect(reads(store).submitReadQuery(q)).rejects.toThrow(/NOT_NEGOTIATED|UNAVAILABLE/);
    await store.acceptHello(hello);const foreign=await query('foreign','READ_STATE',{...scope,baseSha:'a'.repeat(40)});
    await expect(reads(new RbridgeChatPeerStoreV3(path)).submitReadQuery(foreign)).rejects.toThrow(/SCOPE/);
  }));
  it('rejects unsolicited and not-yet-dispatched results without reserving effects',()=>root(async(store,path)=>{
    const q=await query();await expect(store.recordIncoming(await resultFor(q),pins)).rejects.toThrow(/READ_QUERY|SCHEMA_DENIED/);
    await reads(store).submitReadQuery(q);await expect(store.recordIncoming(await resultFor(q),pins)).rejects.toThrow(/READ_QUERY/);
    expect(await file(join(path,'v3-results','journal.json'))).toBeNull();
  }));
  it.each(['action','sessionId','generation','requestDigest','attemptId','effectId','commandId'] as const)('rejects result correlation changes to %s',field=>root(async store=>{
    const q=await query();await reads(store).submitReadQuery(q);await store.takeForDispatch();const result=await resultFor(q);
    const changed={...result,[field]:field==='action'?'DISCOVER_TARGET':field==='generation'?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':field==='requestDigest'||field==='effectId'?'0'.repeat(64):field==='attemptId'?scope.sessionId+':a:1':field==='commandId'?'unsolicited':'exta-'+'a'.repeat(32)};
    await expect(store.recordIncoming(changed,pins)).rejects.toThrow();expect((await reads(store).readQuery(q.command.commandId,scope))?.state).toBe('DISPATCHED');
  }));
  it('accepts exact replay and rejects changed results or duplicate command bytes',()=>root(async store=>{
    const q=await query(),submitted=await reads(store).submitReadQuery(q);expect(await reads(store).submitReadQuery(q)).toEqual(submitted);
    await expect(reads(store).submitReadQuery(await query(q.command.commandId,'DISCOVER_TARGET'))).rejects.toThrow(/REQUEST_ID_COLLISION/);
    await store.takeForDispatch();const result=await resultFor(q);await store.recordIncoming(result,pins);await store.recordIncoming(result,pins);
    await expect(store.recordIncoming({...result,result:{changed:true}},pins)).rejects.toThrow(/REQUEST_ID_COLLISION/);
    expect((await reads(store).readQuery(q.command.commandId,scope))?.result).toEqual(result);
  }));
  it('accepts results only from the owned authenticated channel',()=>root(async(store,path)=>{
    const q=await query();await reads(store).submitReadQuery(q);await store.takeForDispatch();const result=await resultFor(q);
    await expect(new RbridgeChatPeerStoreV3(path).recordIncoming(result,pins)).rejects.toThrow(/CHANNEL_CHANGED/);
    await expect(store.recordIncoming(result,{...pins,peerId:'foreign'})).rejects.toThrow(/PIN_MISMATCH/);
  }));
  it.each([false,true])('never treats expired query as fresh, completed=%s',complete=>root(async store=>{
    const start=Date.now();vi.spyOn(Date,'now').mockReturnValue(start);const q=await query();await reads(store).submitReadQuery(q);
    if(complete){await store.takeForDispatch();await store.recordIncoming(await resultFor(q),pins);}
    vi.spyOn(Date,'now').mockReturnValue(start+5001);await store.heartbeat();expect(await store.takeForDispatch()).toBeNull();
    await expect(reads(store).readQuery(q.command.commandId,scope)).rejects.toThrow('RBRIDGE_READ_QUERY_STALE');
    await expect(reads(store).submitReadQuery(q)).rejects.toThrow('RBRIDGE_READ_QUERY_STALE');
  }));
  it('rejects late results at the deadline even on a renewed live channel',()=>root(async store=>{
    const start=Date.now();vi.spyOn(Date,'now').mockReturnValue(start);const q=await query();await reads(store).submitReadQuery(q);await store.takeForDispatch();
    vi.spyOn(Date,'now').mockReturnValue(start+5000);await store.heartbeat();await expect(store.recordIncoming(await resultFor(q),pins)).rejects.toThrow('RBRIDGE_READ_QUERY_STALE');
  }));
  it.each([false,true])('retains old-channel records but never replays them, completed=%s',complete=>root(async(store,path)=>{
    const q=await query();await reads(store).submitReadQuery(q);if(complete){await store.takeForDispatch();await store.recordIncoming(await resultFor(q),pins);}
    await store.disconnect();const next=new RbridgeChatPeerStoreV3(path);await next.acceptHello(hello);try{
      expect(await next.takeForDispatch()).toBeNull();await expect(reads(next).readQuery(q.command.commandId,scope)).rejects.toThrow('RBRIDGE_READ_QUERY_CHANNEL_CHANGED');
      await expect(reads(next).submitReadQuery(q)).rejects.toThrow('RBRIDGE_READ_QUERY_CHANNEL_CHANGED');
    }finally{await next.disconnect();}
  }));
  it('keeps query/effect/transfer command identities disjoint in both directions',()=>root(async store=>{
    const q=await query(effect.commandId);await reads(store).submitReadQuery(q);
    await expect(store.enqueue(effect,scope)).rejects.toThrow(/REQUEST_ID_COLLISION/);await expect(store.stageChunk(await transfer(effect))).rejects.toThrow(/REQUEST_ID_COLLISION/);
  }));
  it.each(['effect','transfer'] as const)('rejects a query colliding with an existing %s',kind=>root(async store=>{
    if(kind==='effect')await store.enqueue(effect,scope);else await store.stageChunk(await transfer(effect));
    await expect(reads(store).submitReadQuery(await query(effect.commandId))).rejects.toThrow(/REQUEST_ID_COLLISION/);
  }));
  it('preserves a legacy journal, original event bytes and unresolved effect journal',()=>root(async(store,path)=>{
    await store.enqueue(effect,scope);
    const event=await new RbridgeEventSpoolV1().append({eventId:'query-unchanged-event',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:'2026-10-28T12:00:00.000Z',payload:{reason:'TAB_CLOSED'}});
    await store.recordIncoming(event,pins);const journalPath=join(path,'v3-peer','journal.json'),old=await readFile(journalPath),resultPath=join(path,'v3-results','journal.json'),results=await file(resultPath),events=await readFile(join(path,'events.ndjson'));
    expect(JSON.parse(old.toString()).queries).toBeUndefined();expect(await reads(store).readQuery('missing',scope)).toBeNull();expect(await readFile(journalPath)).toEqual(old);
    const q=await query();await reads(store).submitReadQuery(q);expect(await store.takeForDispatch()).toEqual(effect);expect(await store.takeForDispatch()).toEqual(q.command);await store.recordIncoming(await resultFor(q),pins);
    expect(await readFile(join(path,'events.ndjson'))).toEqual(events);expect(await file(resultPath)).toEqual(results);
    expect(JSON.parse((await readFile(journalPath)).toString()).commands).toEqual([{command:effect,state:'DISPATCHED'}]);
  }));
  it('snapshots mutable submission and result inputs before asynchronous work',()=>root(async store=>{
    const q=await query(),original=structuredClone(q),pending=reads(store).submitReadQuery(q);q.command.commandId='changed';q.scope.baseSha='a'.repeat(40);expect((await pending).command).toEqual(original.command);
    await store.takeForDispatch();const result=await resultFor(original),expected=structuredClone(result),write=store.recordIncoming(result,pins);result.result={changed:true};await write;expect((await reads(store).readQuery(original.command.commandId,scope))?.result).toEqual(expected);
  }));
  it('bounds additive query retention at128 without deleting prior records',()=>root(async store=>{
    for(let i=0;i<128;i++){if(i%8===0)await store.heartbeat();await reads(store).submitReadQuery(await query('bounded-'+i));}
    await expect(reads(store).submitReadQuery(await query('bounded-129'))).rejects.toThrow(/BUDGET|LIMIT/);
  }),120000);
  it('checks exact read-query digest and rejects mutations, extra fields and oversized CLI input',()=>root(async store=>{
    const q=await query();await expect(executeRbridgeChatPeerCli(store,['submit-query',encoded({...q,extra:1})])).rejects.toThrow();
    await expect(executeRbridgeChatPeerCli(store,['submit-query',encoded({...q,command:{...q.command,requestDigest:'0'.repeat(64)}})])).rejects.toThrow(/DIGEST/);
    await expect(executeRbridgeChatPeerCli(store,['submit-query','A'.repeat(8196)])).rejects.toThrow();
    expect(await store.takeForDispatch()).toBeNull();
  }));
  it('carries existing V1 command/result over real framed stdio without effect reservation',()=>root(async(store,path)=>{
    await store.disconnect();const input=new PassThrough(),output=new PassThrough(),decoder=new StdioFrameDecoder(),messages:unknown[]=[];
    output.on('data',(data:Buffer)=>messages.push(...decoder.push(data)));const run=runRbridgeChatStdio(input,output,store);void run.catch(()=>undefined);
    async function until(fn:()=>boolean|Promise<boolean>){const end=Date.now()+4000;while(!await fn()){if(Date.now()>=end)throw Error('QUERY_ROUNDTRIP_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,10));}}
    try{input.write(encodeStdioFrame(hello));await until(()=>messages.length===1);const q=await query(),broker=new RbridgeChatPeerStoreV3(path);
      await executeRbridgeChatPeerCli(broker,['submit-query',encoded(q)]);await until(()=>messages.length===2);expect(messages[1]).toEqual(q.command);
      const result=await resultFor(q);input.write(encodeStdioFrame(result));await until(async()=>(await reads(broker).readQuery(q.command.commandId,scope))?.state==='COMPLETE');expect((await reads(broker).readQuery(q.command.commandId,scope))?.result).toEqual(result);
      expect(await file(join(path,'v3-results','journal.json'))).toBeNull();
    }finally{input.end();await run;output.destroy();}
  }));
  it('exposes one strict builder/parser matching the frozen digest contract',async()=>{
    expect(queryModule,'READ_QUERY_DOMAIN_NOT_IMPLEMENTED').not.toBeNull();const module=queryModule!;
    const expected=await query();expect(await module.buildRbridgeReadQuery(scope,'READ_STATE',{},'read-1','2026-10-28T12:00:00.000Z')).toEqual(expected);expect(await module.parseRbridgeReadQuery(expected)).toEqual(expected);
    await expect(module.parseRbridgeReadQuery({...expected,command:{...expected.command,action:'ACTIVATE_CAPTURE'}})).rejects.toThrow();
    await expect(module.parseRbridgeReadQuery({...expected,scope:{...scope,appId:'foreign'}})).rejects.toThrow(/DIGEST|SCOPE/);
  });
});
