import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {assertBoundedRBridgeJson,canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import {rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeJsonValue,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
import type {RBridgeReadonlyHandler} from '../../src/server/rbridgeReadonlyHandlers.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run();vi.restoreAllMocks();await cleanupRBridgeTestStates();});
function gate(){let release!:()=>void;const pending=new Promise<void>(done=>{release=done;});cleanup.push(release);return {pending,release};}
async function fixture(handler:RBridgeReadonlyHandler={async execute(){return {observed:'safe'};}}){
  const f=await createRBridgeTestState(),results=await createRBridgeExecutionResults(f),reserved=new Set<string>();
  const core=createRBridgeExecutionCore({...f,results,subjects:{GITHUB:'zbaksa/rbridge-public:zbaksa',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(id:string){return reserved.has(id);}},handler});
  cleanup.unshift(()=>core.close().catch(()=>undefined));return {...f,core,results,reserved};
}
async function terminal(f:Awaited<ReturnType<typeof fixture>>,id='read-1'):Promise<RBridgeExecutionReceiptV1>{
  const until=Date.now()+5000;while(Date.now()<until){const value=await f.core.status(id,f.context);if(value.status==='RECEIPT'&&value.receipt.phase==='TERMINAL')return value.receipt;await new Promise<void>(done=>setTimeout(done,5));}throw new Error('TERMINAL_DEADLINE');
}
const signal=()=>new AbortController().signal;
describe('durable read-only core admission and scheduling',()=>{
  it('one intent wins an ID and authenticated transports converge without handler duplication',async()=>{
    let calls=0;const held=gate(),f=await fixture({async execute(){calls++;await held.pending;return {observed:'winner'};}}),winner=f.submission();
    const github={...f.context,transport:'GITHUB' as const,authenticatedSubject:'zbaksa/rbridge-public:zbaksa',requestRef:'issue:17'};
    const results=await Promise.all(Array.from({length:40},(_,i)=>f.core.submit(winner,i%2?github:f.context,signal())));
    expect(results.every(result=>result.status==='RECEIPT')).toBe(true);expect(f.journal.capacity().identities).toBe(1);
    const other:RBridgeOperationSubmissionV1={...winner,operation:{kind:'FILE',action:'READ',target:'/mnt/data/other',args:{}}};
    expect(await f.core.submit(other,f.context,signal())).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_INTENT_COLLISION',operationId:'read-1'});
    const record=(await f.journal.get('read-1'))!;expect(record.intentSha256).toBe(rbridgeOperationIntentDigest(winner));expect(Object.keys(record.observations).sort()).toEqual(['GITHUB','MCP']);expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(10000);
    held.release();expect((await terminal(f)).outcome).toBe('PASS');expect(calls).toBe(1);
  });
  it('rejection creates no claim for wrong subject, principal, target and reserved legacy ID',async()=>{
    const f=await fixture(),s=f.submission();
    for(const [submission,context] of [[s,{...f.context,authenticatedSubject:'uid:other'}],[s,{...f.context,principalId:'other'}],[{...s,principalId:'other'},f.context],[{...s,targetInstanceId:'other'},f.context]] as const){expect(await f.core.submit(submission,context,signal())).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_SCOPE_INVALID'});expect(await f.journal.get(s.operationId)).toBeUndefined();}
    f.reserved.add(s.operationId);expect(await f.core.submit(s,f.context,signal())).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_LEGACY_ID_RESERVED'});expect(await f.journal.get(s.operationId)).toBeUndefined();expect(f.journal.capacity().identities).toBe(0);
    await expect(f.core.status('unknown',{...f.context,authenticatedSubject:'wrong'})).rejects.toThrow('RBRIDGE_CORE_SCOPE_INVALID');
  });
  it('pre-admission abort and unsafe or over-depth JSON allocate no durable identity',async()=>{
    const f=await fixture(),controller=new AbortController();controller.abort();await expect(f.core.submit(f.submission(),f.context,controller.signal)).rejects.toThrow(/ABORT/);
    const bad=JSON.parse(JSON.stringify(f.submission()));bad.operation={kind:'PROCESS',action:'START',args:JSON.parse('{"deep":{"constructor":{}}}')};await expect(f.core.submit(bad,f.context,signal())).rejects.toThrow();
    let nested:RBridgeJsonValue='leaf';for(let i=0;i<14;i++)nested={nested};const tooDeep={...f.submission(),operation:{kind:'PROCESS',action:'START',args:{deep:nested}}} as RBridgeOperationSubmissionV1;await expect(f.core.submit(tooDeep,f.context,signal())).rejects.toThrow();expect(f.journal.capacity().identities).toBe(0);
  });
  it('authorization returns before execution and its frozen snapshot stays exact after completion',async()=>{
    let entered!:()=>void;const started=new Promise<void>(done=>{entered=done;}),held=gate();
    const f:Awaited<ReturnType<typeof fixture>>=await fixture({async execute(s){expect(f.serializer.isHeld(s.operationId)).toBe(false);expect((await f.journal.get(s.operationId))?.receipt.phase).toBe('RUNNING');entered();await held.pending;return {observed:'safe'};}});
    const admitted=await f.core.submit(f.submission(),f.context,signal());expect(admitted.status).toBe('RECEIPT');if(admitted.status!=='RECEIPT')throw new Error('NO_RECEIPT');
    const initial=JSON.stringify(admitted);expect(admitted.receipt.phase).toBe('AUTHORIZED');expect(admitted.receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','AUTHORIZED']);expect(Object.isFrozen(admitted.receipt.transitions)).toBe(true);await started;
    expect((await f.core.status('read-1',f.context)).status).toBe('RECEIPT');held.release();expect((await terminal(f)).transitions.map(t=>t.phase)).toEqual(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL']);expect(JSON.stringify(admitted)).toBe(initial);
  });
  it('disabled operations finish the short policy BLOCK path without invoking handlers',async()=>{
    let calls=0;const f=await fixture({async execute(){calls++;throw new Error('MUTATION');}}),s:RBridgeOperationSubmissionV1={...f.submission(),operation:{kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/a',args:{text:'change'}}};
    const result=await f.core.submit(s,f.context,signal());expect(result).toMatchObject({status:'RECEIPT',receipt:{phase:'TERMINAL',outcome:'BLOCKED',policy:{decision:'BLOCK'},sideEffects:{state:'NONE_PROVEN'}}});if(result.status!=='RECEIPT')throw new Error('NO_RECEIPT');expect(result.receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','TERMINAL']);expect(calls).toBe(0);expect(f.journal.capacity().nonterminal).toBe(0);
  });
  it('persists a policy BLOCK at the exact depth16 input boundary despite its journal envelope',async()=>{
    const f=await fixture();let nested:RBridgeJsonValue='leaf';for(let i=0;i<13;i++)nested={nested};const s:RBridgeOperationSubmissionV1={...f.submission(),operation:{kind:'PROCESS',action:'START',args:{deep:nested}}};expect(()=>assertBoundedRBridgeJson(s)).not.toThrow();
    const result=await f.core.submit(s,f.context,signal());expect(result).toMatchObject({status:'RECEIPT',receipt:{outcome:'BLOCKED'}});expect((await f.journal.get(s.operationId))?.submission).toEqual(s);
  });
  it('the storage port itself accepts that valid depth16 submission inside its private envelope',async()=>{
    const f=await fixture();let nested:RBridgeJsonValue='leaf';for(let i=0;i<13;i++)nested={nested};const s:RBridgeOperationSubmissionV1={...f.submission(),operation:{kind:'PROCESS',action:'START',args:{deep:nested}}};expect(()=>assertBoundedRBridgeJson(s)).not.toThrow();
    const record=await f.serializer.run(s.operationId,()=>f.journal.claim({submission:s,decision:f.policy.evaluate(s),context:f.context}));expect(record.receipt.phase).toBe('CLAIMED');expect((await f.journal.get(s.operationId))?.submission).toEqual(s);
  });
  it('bounds active handlers to four and default aggregate reservations to32 while known lookups remain available',async()=>{
    const held=gate();let active=0,max=0;const f=await fixture({async execute(){active++;max=Math.max(active,max);await held.pending;active--;return {ok:true};}});
    const accepted=await Promise.all(Array.from({length:32},(_,n)=>f.core.submit(f.submission(`read-${n}`),f.context,signal())));expect(accepted.every(r=>r.status==='RECEIPT')).toBe(true);expect(f.journal.capacity().nonterminal).toBe(32);
    expect(await f.core.submit(f.submission('read-33'),f.context,signal())).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_CAPACITY_REACHED'});expect(await f.journal.get('read-33')).toBeUndefined();
    await new Promise<void>(done=>setImmediate(done));await expect.poll(()=>active,{timeout:3000}).toBe(4);expect((await f.core.status('read-0',f.context)).status).toBe('RECEIPT');expect((await f.core.result('read-0',0,16,f.context)).status).toBe('NOT_READY');expect((await f.core.submit(f.submission('read-0'),f.context,signal())).status).toBe('RECEIPT');
    held.release();await Promise.all(Array.from({length:32},(_,n)=>terminal(f,`read-${n}`)));expect(max).toBe(4);expect(f.journal.capacity().identities).toBe(32);
  },15000);
  it('enforces the128 nonterminal ceiling independently of aggregate reservation accounting',async()=>{
    const f=await fixture(),journal={...f.journal,capacity:()=>({...f.journal.capacity(),nonterminal:128})};
    const core=createRBridgeExecutionCore({...f,journal,subjects:{MCP:`uid:${f.uid}`,GITHUB:'zbaksa/rbridge-public:zbaksa'},legacyReservations:{async isReserved(){return false;}},handler:{async execute(){throw new Error('NOT_ADMITTED');}}});cleanup.unshift(()=>core.close().catch(()=>undefined));
    expect(await core.submit(f.submission(),f.context,signal())).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_CAPACITY_REACHED'});expect(await f.journal.get('read-1')).toBeUndefined();
  });
  it('PASS requires committed output whose whole digest and postconditions match its terminal receipt',async()=>{
    const f=await fixture();await f.core.submit(f.submission(),f.context,signal());const receipt=await terminal(f),bytes=await readFile(join(f.root,'results','read-1.json'));expect(receipt.outcome).toBe('PASS');expect(receipt.resultSha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(receipt.postconditions).toEqual([{name:'read-within-policy',status:'PASS',evidenceSha256:receipt.policy.policySha256},{name:'result-digest',status:'PASS',evidenceSha256:receipt.resultSha256}]);
    expect(await f.core.result('read-1',0,32768,f.context)).toMatchObject({status:'RESULT',eof:true,dataBase64:bytes.toString('base64')});const original=await readFile(join(f.root,'operations','read-1.json'));await f.core.submit(f.submission(),f.context,signal());expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(original);
    await writeFile(join(f.root,'results','read-1.json'),canonicalRBridgeJson({observed:'corrupt'}));await expect(f.core.result('read-1',0,16,f.context)).rejects.toThrow(/DIGEST/);
  });
  it('sanitizes handler failures and never emits unsupported cancellation or rollback claims',async()=>{
    const f=await fixture({async execute(){throw new Error('/private/credentials SECRET');}});await f.core.submit(f.submission(),f.context,signal());expect(await terminal(f)).toMatchObject({outcome:'FAIL',reason:'RBRIDGE_CORE_READ_FAILED',sideEffects:{state:'NONE_PROVEN'},cancellation:{state:'NONE'}});
  });
  it('never acknowledges PASS after a result fsync failure and retains actual staging evidence',async()=>{
    const f=await fixture(),files=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{syncFile:async()=>{throw Object.assign(new Error('ENOSPC private detail'),{code:'ENOSPC'});}}}),results=await createRBridgeExecutionResults({...f,files});
    const core=createRBridgeExecutionCore({...f,results,subjects:{GITHUB:'zbaksa/rbridge-public:zbaksa',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler:{async execute(){return {read:'safe'};}}});cleanup.unshift(()=>core.close().catch(()=>undefined));
    await core.submit(f.submission(),f.context,signal());await expect.poll(async()=> (await f.journal.get('read-1'))?.receipt.phase,{timeout:3000}).toBe('TERMINAL');const receipt=(await f.journal.get('read-1'))!.receipt;expect(receipt.outcome).toBe('FAIL');expect(receipt.resultSha256).toBeUndefined();expect(receipt.reason).toBe('RBRIDGE_CORE_RESULT_COMMIT_FAILED');expect(f.journal.capacity().resultBytes).toBeGreaterThan(0);
  });
  it('the result commit verifies actual stored bytes before returning its digest',async()=>{
    const f=await fixture();await f.running();const files=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{async syncFile(handle){const size=(await handle.stat()).size;await handle.write(Buffer.alloc(size,120),0,size,0);await handle.sync();}}}),results=await createRBridgeExecutionResults({...f,files});
    await expect(f.serializer.run('read-1',()=>results.commit('read-1',{observed:'safe'}))).rejects.toThrow('RBRIDGE_CORE_RESULT_DIGEST_MISMATCH');expect((await f.journal.get('read-1'))?.receipt.phase).toBe('RUNNING');
  });
});
