import {describe,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonicalJson,V3_CAPABILITIES} from '../src/domain/rbridgeEffectProtocol.js';
import {negotiateHello,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {RbridgeScopeStopStoreV1} from '../src/extension/rbridgeScopeStopStore.js';

type Row=Record<string,unknown>;
type AsyncParser=(input:unknown,expected?:unknown)=>Promise<Row>;
interface Contract {
  buildScopeStopRequest:AsyncParser;parseScopeStopRequest:AsyncParser;
  buildScopeQuiescenceQuery:AsyncParser;parseScopeQuiescenceQuery:AsyncParser;
  assertScopeQuiescenceQueryCurrent:(query:unknown,current:unknown)=>void;
  buildScopeResultInventory:AsyncParser;parseScopeResultInventory:AsyncParser;
  buildWorkerQuiescenceReport:AsyncParser;parseWorkerQuiescenceReport:AsyncParser;
  buildNativeQuiescenceReport:AsyncParser;parseNativeQuiescenceReport:AsyncParser;
  buildScopeQuiescenceRecord:AsyncParser;parseScopeQuiescenceRecord:AsyncParser;
}
const path='../src/domain/rbridgeScopeQuiescence.js';
const module=existsSync(new URL('../src/domain/rbridgeScopeQuiescence.ts',import.meta.url))?await import(path):{};
function api():Contract {
  for(const name of ['buildScopeStopRequest','parseScopeStopRequest','buildScopeQuiescenceQuery','parseScopeQuiescenceQuery','assertScopeQuiescenceQueryCurrent','buildScopeResultInventory','parseScopeResultInventory','buildWorkerQuiescenceReport','parseWorkerQuiescenceReport','buildNativeQuiescenceReport','parseNativeQuiescenceReport','buildScopeQuiescenceRecord','parseScopeQuiescenceRecord'])expect(typeof module[name],'missing contract '+name).toBe('function');
  return module as Contract;
}
const scope={appId:'cocwin',baseSha:'2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db',sessionId:'exta-4786c8bd94d2feecc1e26a031b0693d6',generation:'7e7d5e17-2c44-4094-a6c8-0cf470ed564c'};
const iso='2026-10-29T21:00:00.000Z',submittedAt=1793307600000;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function sign(row:Row,field='sha256'):Row {const next=structuredClone(row);delete next[field];return {...next,[field]:hash(next)};}
function request():Row{return sign({schema:'RBRIDGE_SCOPE_STOP_REQUEST_V1',requestId:'fixture-stop',scope:structuredClone(scope),challenge:'c'.repeat(64),issuedAt:iso},'requestDigest');}
function fence():Row{return sign({schema:'RBRIDGE_SCOPE_STOP_FENCE_V1',state:'STOP_REQUESTED',request:request(),recordedAt:iso});}
function query():Row{return sign({schema:'RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1',queryId:'fixture-query',queryNonce:'d'.repeat(64),request:request(),channelId:'a'.repeat(32),peerPinsSha256:'b'.repeat(64),submittedAt,expiresAt:submittedAt+30000});}
function inventory():Row{return sign({schema:'RBRIDGE_SCOPE_RESULT_INVENTORY_V1',scope:structuredClone(scope),entryCount:0,unresolvedCount:0,entriesSha256:hash([])});}
function worker():Row{return sign({schema:'RBRIDGE_SCOPE_QUIESCENCE_WORKER_V1',querySha256:query().sha256,fence:fence(),sealed:true,captureStopped:true,pendingHandlers:0,pendingReaders:0,pendingEgress:0,unresolvedCaptureCount:0,resultInventory:inventory(),eventHead:{sequence:0,eventSha256:null},observedAt:iso});}
function native():Row{return sign({schema:'RBRIDGE_SCOPE_QUIESCENCE_NATIVE_V1',querySha256:query().sha256,worker:worker(),resultInventory:inventory(),eventHead:{sequence:0,eventSha256:null},observedAt:iso});}
function record():Row{return sign({schema:'RBRIDGE_SCOPE_QUIESCENCE_RECORD_V1',query:query(),state:'COMPLETE',nativeReport:native(),receivedAt:submittedAt+1});}
function current(patch:Row={}):Row{return {scope:structuredClone(scope),channelId:'a'.repeat(32),peerPinsSha256:'b'.repeat(64),now:submittedAt+1,...patch};}
function body(input:Row,remove:readonly string[]):Row {const out=structuredClone(input);for(const key of remove)delete out[key];return out;}
const foreignScopes=Object.keys(scope).map(key=>({...scope,[key]:key==='appId'?'other-app':key==='baseSha'?'0'.repeat(40):key==='sessionId'?'exta-'+'0'.repeat(32):'00000000-0000-4000-8000-000000000000'}));

describe('scope STOP and quiescence shared contract',()=>{
  it('builds the exact original STOP request and retains its issuedAt spelling',async()=>{
    const input=body(request(),['schema','requestDigest']),before=structuredClone(input),out=await api().buildScopeStopRequest(input);
    expect(out).toEqual(request());expect(input).toEqual(before);expect(Object.hasOwn(out,'issuedAtISO')).toBe(false);
    expect(await api().parseScopeStopRequest(out,scope)).toEqual(out);(input.scope as Row).appId='later';expect(out).toEqual(request());
  });
  it('is byte-compatible with the existing immutable worker STOP fence',async()=>{
    const data:Row={},storage={get:async(key:string)=>key in data?{[key]:structuredClone(data[key])}:{},set:async(items:Row)=>{Object.assign(data,structuredClone(items));}};
    const stops=new RbridgeScopeStopStoreV1(storage,scope);await stops.initialize();const req=await api().buildScopeStopRequest(body(request(),['schema','requestDigest']));
    const retained=await stops.requestStop(req),facts=body(worker(),['schema','sha256','querySha256']);facts.fence=retained;
    const out=await api().buildWorkerQuiescenceReport(query(),facts);expect(await api().parseWorkerQuiescenceReport(out,query())).toEqual(out);
    expect(await stops.requestStop(req)).toEqual(retained);
  });
  it.each(foreignScopes)('binds all four STOP scope fields',async foreign=>{
    await expect(api().parseScopeStopRequest(request(),foreign)).rejects.toThrow();
  });
  it('rejects STOP challenge/digest corruption and unknown fields',async()=>{
    for(const bad of [{...request(),challenge:'x'.repeat(64)},{...request(),requestDigest:'0'.repeat(64)},{...request(),extra:true},{...request(),issuedAtISO:iso}]){
      await expect(api().parseScopeStopRequest(bad,scope)).rejects.toThrow();
    }
    const extraScope={...request(),scope:{...scope,alias:true}};await expect(api().parseScopeStopRequest(extraScope,scope)).rejects.toThrow();
  });
  it('rejects accessors without invoking them before any asynchronous validation',async()=>{
    let reads=0;const bad=request();Object.defineProperty(bad,'challenge',{enumerable:true,get:()=>{reads++;return 'c'.repeat(64);}});
    await expect(api().parseScopeStopRequest(bad,scope)).rejects.toThrow();expect(reads).toBe(0);
    const nested=query();Object.defineProperty(nested.request as Row,'scope',{enumerable:true,get:()=>{reads++;return scope;}});
    await expect(api().parseScopeQuiescenceQuery(nested)).rejects.toThrow();expect(reads).toBe(0);
  });
  it('rejects noncanonical ISO dates, hostile prototypes, symbols and request budgets',async()=>{
    const badDates=['2026-02-30T21:00:00.000Z','2026-10-29T21:00:00Z','2026-10-29T21:00:00.000+00:00'];
    for(const issuedAt of badDates)await expect(api().parseScopeStopRequest(sign({...request(),issuedAt},'requestDigest'),scope)).rejects.toThrow();
    const symbol=request();Object.defineProperty(symbol,Symbol('hidden'),{value:true});await expect(api().parseScopeStopRequest(symbol,scope)).rejects.toThrow();
    await expect(api().parseScopeStopRequest(Object.assign(Object.create({}),request()),scope)).rejects.toThrow();
    await expect(api().buildScopeStopRequest({...body(request(),['schema','requestDigest']),requestId:'x'.repeat(8193)})).rejects.toThrow();
  });
  it('builds an immutable query with the exact Linux-clock thirty-second window',async()=>{
    const input=body(query(),['schema','sha256','expiresAt']),out=await api().buildScopeQuiescenceQuery(input);
    expect(out).toEqual(query());expect(await api().parseScopeQuiescenceQuery(out)).toEqual(out);
    input.queryNonce='f'.repeat(64);expect(out).toEqual(query());
    await expect(api().buildScopeQuiescenceQuery({...input,submittedAt:Number.MAX_SAFE_INTEGER})).rejects.toThrow();
  });
  it('rejects malformed query fields and recomputed invalid TTLs',async()=>{
    for(const patch of [{queryId:'x'.repeat(192)},{queryId:'space id'},{queryNonce:'e'.repeat(63)},{channelId:'A'.repeat(32)},{peerPinsSha256:'a'.repeat(63)},{submittedAt:-1},{expiresAt:submittedAt+29999},{expiresAt:Number.MAX_SAFE_INTEGER},{extra:true}]){
      await expect(api().parseScopeQuiescenceQuery(sign({...query(),...patch}))).rejects.toThrow();
    }
    await expect(api().parseScopeQuiescenceQuery({...query(),sha256:'0'.repeat(64)})).rejects.toThrow();
    await expect(api().parseScopeQuiescenceQuery({...query(),submittedAt:1.5})).rejects.toThrow();
  });
  it('parses retained expired records but explicitly rejects stale/current-channel mismatches',async()=>{
    const q=await api().parseScopeQuiescenceQuery(query());expect(()=>api().assertScopeQuiescenceQueryCurrent(q,current())).not.toThrow();
    for(const now of [submittedAt-1,submittedAt+30000,Number.NaN,1.5])expect(()=>api().assertScopeQuiescenceQueryCurrent(q,current({now}))).toThrow();
    for(const foreign of foreignScopes)expect(()=>api().assertScopeQuiescenceQueryCurrent(q,current({scope:foreign}))).toThrow();
    expect(()=>api().assertScopeQuiescenceQueryCurrent(q,current({channelId:'e'.repeat(32)}))).toThrow();
    expect(()=>api().assertScopeQuiescenceQueryCurrent(q,current({peerPinsSha256:'e'.repeat(64)}))).toThrow();
    expect(await api().parseScopeQuiescenceRecord(record())).toEqual(record());
  });
  it('builds and validates generic scoped inventory without Native provenance labels',async()=>{
    const input=body(inventory(),['schema','sha256']);expect(await api().buildScopeResultInventory(input)).toEqual(inventory());
    expect(await api().parseScopeResultInventory(inventory(),scope)).toEqual(inventory());
    await expect(api().parseScopeResultInventory({...inventory(),schema:'RBRIDGE_NATIVE_SCOPE_RESULT_INVENTORY_V1'},scope)).rejects.toThrow();
    for(const foreign of foreignScopes)await expect(api().parseScopeResultInventory(inventory(),foreign)).rejects.toThrow();
    for(const patch of [{entryCount:4097},{entryCount:-1},{unresolvedCount:1},{entriesSha256:'x'.repeat(64)},{extra:true}]){
      await expect(api().parseScopeResultInventory(sign({...inventory(),...patch}),scope)).rejects.toThrow();
    }
  });
  it('builds complete worker/native factual reports and independent record digests',async()=>{
    expect(await api().buildWorkerQuiescenceReport(query(),body(worker(),['schema','sha256','querySha256']))).toEqual(worker());
    expect(await api().parseWorkerQuiescenceReport(worker(),query())).toEqual(worker());
    expect(await api().buildNativeQuiescenceReport(query(),body(native(),['schema','sha256','querySha256']))).toEqual(native());
    expect(await api().parseNativeQuiescenceReport(native(),query())).toEqual(native());
    expect(await api().buildScopeQuiescenceRecord(body(record(),['schema','sha256']))).toEqual(record());
    expect(await api().parseScopeQuiescenceRecord(record())).toEqual(record());
  });
  it('rejects a freshly rehashed fence with a different original challenge/request',async()=>{
    const req=sign({...request(),challenge:'e'.repeat(64)},'requestDigest'),differentFence=sign({...fence(),request:req});
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),fence:differentFence}),query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),fence:sign({...fence(),state:'STOP_FINALIZED'})}),query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),fence:{...fence(),sha256:'0'.repeat(64)}}),query())).rejects.toThrow();
  });
  it('rejects cross-query worker/native envelopes even when their own hashes are valid',async()=>{
    const other=sign({...query(),queryNonce:'e'.repeat(64)});
    await expect(api().parseWorkerQuiescenceReport(worker(),other)).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),querySha256:'0'.repeat(64)}),query())).rejects.toThrow();
    await expect(api().parseNativeQuiescenceReport(native(),other)).rejects.toThrow();
    await expect(api().parseNativeQuiescenceReport(sign({...native(),worker:sign({...worker(),querySha256:'0'.repeat(64)})}),query())).rejects.toThrow();
    await expect(api().parseNativeQuiescenceReport({...native(),sha256:'0'.repeat(64)},query())).rejects.toThrow();
  });
  it('binds both report inventories to the full query scope',async()=>{
    const foreign=sign({...inventory(),scope:foreignScopes[0]});
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),resultInventory:foreign}),query())).rejects.toThrow();
    await expect(api().parseNativeQuiescenceReport(sign({...native(),resultInventory:foreign}),query())).rejects.toThrow();
  });
  it('enforces bounded counters, exact fields and coherent event head shape',async()=>{
    for(const name of ['pendingHandlers','pendingReaders','pendingEgress','unresolvedCaptureCount'])for(const value of [-1,4097])await expect(api().parseWorkerQuiescenceReport(sign({...worker(),[name]:value}),query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport({...worker(),pendingReaders:0.5},query())).rejects.toThrow();
    for(const eventHead of [{sequence:0,eventSha256:'a'.repeat(64)},{sequence:1,eventSha256:null},{sequence:-1,eventSha256:null},{sequence:1,eventSha256:'g'.repeat(64)},{sequence:1,eventSha256:'a'.repeat(64),extra:true}])await expect(api().parseWorkerQuiescenceReport(sign({...worker(),eventHead}),query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),extra:true}),query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport(sign({...worker(),sealed:'true'}),query())).rejects.toThrow();
    await expect(api().parseNativeQuiescenceReport(sign({...native(),observedAt:'2026-02-30T00:00:00.000Z'}),query())).rejects.toThrow();
  });
  it('retains nonzero and mismatched factual observations without manufacturing PASS',async()=>{
    const w=sign({...worker(),sealed:false,captureStopped:false,pendingHandlers:1,pendingReaders:2,pendingEgress:3,unresolvedCaptureCount:4,observedAt:'2099-01-01T00:00:00.000Z'});
    expect(await api().parseWorkerQuiescenceReport(w,query())).toEqual(w);
    const n=sign({...native(),worker:w,eventHead:{sequence:1,eventSha256:'e'.repeat(64)},resultInventory:sign({...inventory(),entryCount:1,unresolvedCount:1})});
    expect(await api().parseNativeQuiescenceReport(n,query())).toEqual(n);expect(Object.hasOwn(n,'status')).toBe(false);
  });
  it('rejects final-newline scalar aliases even with freshly recomputed digests',async()=>{
    for(const patch of [{requestId:'fixture-stop\n'},{challenge:'c'.repeat(64)+'\n'}])await expect(api().parseScopeStopRequest(sign({...request(),...patch},'requestDigest'),scope)).rejects.toThrow();
    for(const patch of [{queryId:'fixture-query\n'},{queryNonce:'d'.repeat(64)+'\n'},{channelId:'a'.repeat(32)+'\n'},{peerPinsSha256:'b'.repeat(64)+'\n'}])await expect(api().parseScopeQuiescenceQuery(sign({...query(),...patch}))).rejects.toThrow();
    const max=await api().buildScopeQuiescenceQuery({...body(query(),['schema','sha256','expiresAt']),queryId:'x'.repeat(191)});expect((max.queryId as string).length).toBe(191);
  });
  it('captures nested report and expected-query inputs before the first await',async()=>{
    const input=worker(),expected=query(),pending=api().parseWorkerQuiescenceReport(input,expected);
    ((input.fence as Row).request as Row).challenge='e'.repeat(64);((expected.request as Row).scope as Row).appId='changed';
    expect(await pending).toEqual(worker());
    const r=record(),read=api().parseScopeQuiescenceRecord(r);(r.query as Row).queryNonce='e'.repeat(64);
    expect(await read).toEqual(record());
  });
  it('rejects accessor and nonenumerable report fields without executing page code',async()=>{
    let reads=0;const w=worker();Object.defineProperty(w,'pendingReaders',{enumerable:true,get:()=>{reads++;return 0;}});
    await expect(api().parseWorkerQuiescenceReport(w,query())).rejects.toThrow();expect(reads).toBe(0);
    const n=native();Object.defineProperty(n,'extra',{enumerable:false,value:true});await expect(api().parseNativeQuiescenceReport(n,query())).rejects.toThrow();
    await expect(api().parseWorkerQuiescenceReport({...worker(),status:'PASS'},query())).rejects.toThrow();
  });
  it('enforces record state/null correlation and the Linux reception window',async()=>{
    for(const state of ['QUEUED','DISPATCHED']){const r=sign({...record(),state,nativeReport:null,receivedAt:null});expect(await api().parseScopeQuiescenceRecord(r)).toEqual(r);}
    for(const patch of [{state:'PASS'},{nativeReport:null},{receivedAt:null},{receivedAt:submittedAt-1},{receivedAt:submittedAt+30000},{state:'QUEUED'},{extra:true}]){
      await expect(api().parseScopeQuiescenceRecord(sign({...record(),...patch}))).rejects.toThrow();
    }
    const alien=sign({...query(),queryNonce:'e'.repeat(64)});await expect(api().parseScopeQuiescenceRecord(sign({...record(),query:alien}))).rejects.toThrow();
    await expect(api().parseScopeQuiescenceRecord({...record(),sha256:'0'.repeat(64)})).rejects.toThrow();
  });
});

const CAP='CHAT_SCOPE_QUIESCENCE_V1';
function hello(capabilities:string[],protocolMinor=1):RbridgeChatHelloV1{return {schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor,releaseSha:'a'.repeat(40),maxMessageBytes:65536,capabilities,browserInstanceId:'fixture-browser',browserProfileId:'fixture-profile',nativeHostVersion:'fixture-native'};}
describe('optional scope quiescence negotiation',()=>{
  it('negotiates only the explicit mutual optional capability without changing V3 requirements',()=>{
    expect(V3_CAPABILITIES.includes(CAP as typeof V3_CAPABILITIES[number])).toBe(false);
    const caps=[...V3_CAPABILITIES,CAP];expect(negotiateHello(hello(caps),hello(caps)).capabilities).toContain(CAP);
  });
  it('retains existing V3 and minor-zero behavior when either side lacks support',()=>{
    const caps=[...V3_CAPABILITIES,CAP];for(const pair of [[hello(caps),hello([...V3_CAPABILITIES])],[hello([...V3_CAPABILITIES]),hello(caps)],[hello(caps,0),hello(caps)]]){
      expect(negotiateHello(pair[0]!,pair[1]!).capabilities).not.toContain(CAP);
    }
  });
});
