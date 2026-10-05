import {mkdtemp,open,readFile,readdir,readlink,rm,writeFile,type FileHandle} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {rbridgeOperationIntentDigest,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeReadonlyHandlers,type RBridgeReadonlyHandler} from '../../src/server/rbridgeReadonlyHandlers.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';
const cleanup:Array<()=>void|Promise<unknown>>=[],sources:string[]=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await Promise.resolve(run()).catch(()=>undefined);vi.restoreAllMocks();await cleanupRBridgeTestStates();await Promise.all(sources.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
function gate(){let release!:()=>void;const pending=new Promise<void>(done=>{release=done;});cleanup.push(release);return {pending,release};}
async function fixture(handler:RBridgeReadonlyHandler){const f=await createRBridgeTestState(),results=await createRBridgeExecutionResults(f),core=createRBridgeExecutionCore({...f,results,subjects:{GITHUB:'example/control:operator',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler});cleanup.unshift(()=>core.close());return {...f,core,results};}
async function terminal(f:Awaited<ReturnType<typeof fixture>>,id='read-1'){await expect.poll(async()=>{const value=await f.core.status(id,f.context);return value.status==='RECEIPT'?value.receipt.phase:value.status;},{timeout:5000}).toBe('TERMINAL');return (await f.journal.get(id))!.receipt;}
async function handlesBelow(root:string){let count=0;for(const fd of await readdir('/proc/self/fd'))try{const path=await readlink(`/proc/self/fd/${fd}`);if(path===root||path.startsWith(root+'/'))count++;}catch{}return count;}
describe('durable cancellation and actual handler settlement',()=>{
  it('queued cancel has the authorized terminal path and never dispatches its handler',async()=>{
    const held=gate(),calls:string[]=[];const f=await fixture({async execute(s){calls.push(s.operationId);await held.pending;return null;}});for(let n=0;n<4;n++)await f.core.submit(f.submission(`held-${n}`),f.context,new AbortController().signal);await expect.poll(()=>calls.length,{timeout:3000}).toBe(4);
    const s=f.submission();await f.core.submit(s,f.context,new AbortController().signal);const requested=await f.core.requestCancel(s.operationId,rbridgeOperationIntentDigest(s),f.context);expect(requested).toMatchObject({status:'REQUESTED',receipt:{phase:'AUTHORIZED',cancellation:{state:'REQUESTED'}}});
    const receipt=await terminal(f);expect(receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','AUTHORIZED','TERMINAL']);expect(receipt).toMatchObject({outcome:'TERMINATED',policy:{decision:'ALLOW'},sideEffects:{state:'NONE_PROVEN'},cancellation:{state:'REQUESTED'}});expect(calls).not.toContain('read-1');held.release();
  });
  it('running cancel and shutdown wait for actual FILE read settlement and descriptor close',async()=>{
    const f=await createRBridgeTestState(),sourceRoot=await mkdtemp(join(homedir(),'.rbridge-cancel-source-'));sources.push(sourceRoot);const path=join(sourceRoot,'data');await writeFile(path,'actual');const probe=await open(path,'r'),prototype=Object.getPrototypeOf(probe) as {read(...args:unknown[]):Promise<unknown>};await probe.close();const original=prototype.read,held=gate();let entered!:()=>void;const started=new Promise<void>(done=>{entered=done;});
    vi.spyOn(prototype,'read').mockImplementation(async function(this:FileHandle,...args:unknown[]){if(await readlink(`/proc/self/fd/${this.fd}`)===path){entered();await held.pending;}return Reflect.apply(original,this,args);});
    const handler=createRBridgeReadonlyHandlers({policy:f.policy,sourceRoot,health:{snapshot:()=>({})}}),results=await createRBridgeExecutionResults(f),core=createRBridgeExecutionCore({...f,results,subjects:{GITHUB:'example/control:operator',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler});cleanup.unshift(()=>core.close());const s:RBridgeOperationSubmissionV1={...f.submission(),operation:{kind:'FILE',action:'READ',target:'/mnt/data/data',args:{}}};
    await core.submit(s,f.context,new AbortController().signal);await started;expect(await handlesBelow(sourceRoot)).toBeGreaterThan(0);await core.requestCancel(s.operationId,rbridgeOperationIntentDigest(s),f.context);expect((await f.journal.get(s.operationId))?.receipt).toMatchObject({phase:'RUNNING',cancellation:{state:'REQUESTED'}});
    let closed=false;const closing=core.close().then(()=>{closed=true;});await new Promise<void>(done=>setImmediate(done));expect(closed).toBe(false);await expect(core.submit(f.submission('late'),f.context,new AbortController().signal)).rejects.toThrow('RBRIDGE_CORE_CLOSED');held.release();await closing;expect(await handlesBelow(sourceRoot)).toBe(0);expect((await f.journal.get('read-1'))!.receipt).toMatchObject({outcome:'TERMINATED',cancellation:{state:'REQUESTED'},sideEffects:{state:'NONE_PROVEN'}});
  });
  it('wrong digest or subject and unknown cancellation leave the winning intent untouched',async()=>{
    const held=gate(),f=await fixture({async execute(){await held.pending;return {winner:true};}}),s=f.submission();await f.core.submit(s,f.context,new AbortController().signal);const before=(await f.serializer.run('read-1',()=>f.journal.get('read-1')))!.receipt.cancellation;
    expect(await f.core.requestCancel('read-1','0'.repeat(64),f.context)).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_INTENT_COLLISION'});expect(await f.core.requestCancel('read-1',rbridgeOperationIntentDigest(s),{...f.context,authenticatedSubject:'other'})).toMatchObject({status:'REJECTED',reason:'RBRIDGE_CORE_SCOPE_INVALID'});expect(await f.core.requestCancel('unknown','0'.repeat(64),f.context)).toMatchObject({status:'NOT_FOUND',operationId:'unknown'});expect(await f.journal.get('unknown')).toBeUndefined();expect((await f.journal.get('read-1'))!.receipt.cancellation).toEqual(before);held.release();expect((await terminal(f)).outcome).toBe('PASS');
  });
  it('verified completion wins and a late cancellation preserves exact terminal bytes',async()=>{
    const f=await fixture({async execute(){return {complete:true};}}),s=f.submission();await f.core.submit(s,f.context,new AbortController().signal);const receipt=await terminal(f),bytes=await readFile(join(f.root,'operations','read-1.json'));expect(await f.core.requestCancel('read-1',rbridgeOperationIntentDigest(s),f.context)).toEqual({status:'UNCHANGED_TERMINAL',receipt});expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(bytes);
  });
  it('persisted running cancel recovers to TERMINATED without a new handler observation',async()=>{
    let calls=0;const f=await fixture({async execute(){calls++;return null;}}),record=await f.running();const cancellation={state:'REQUESTED' as const,requestedAt:record.receipt.transitions.at(-1)!.at};await f.serializer.run('read-1',()=>f.journal.update('read-1',record.revision,{...record,revision:record.revision+1,receipt:{...record.receipt,cancellation}}));await f.core.recover();expect(await terminal(f)).toMatchObject({outcome:'TERMINATED',cancellation,sideEffects:{state:'NONE_PROVEN'}});expect(calls).toBe(0);
  });
  it('abort during durable admission is reconciled after authorization without a short TERMINATED path',async()=>{
    const held=gate(),f=await fixture({async execute(){await held.pending;return null;}}),controller=new AbortController(),actual=f.journal.claim;
    const journal={...f.journal,async claim(...args:Parameters<typeof actual>){const record=await actual(...args);controller.abort();return record;}};
    const core=createRBridgeExecutionCore({...f,journal,subjects:{GITHUB:'example/control:operator',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler:{async execute(){await held.pending;return null;}}});cleanup.unshift(()=>core.close());await core.submit(f.submission(),f.context,controller.signal);held.release();await expect.poll(async()=> (await f.journal.get('read-1'))?.receipt.phase,{timeout:3000}).toBe('TERMINAL');const receipt=(await f.journal.get('read-1'))!.receipt;expect(receipt.outcome).toBe('TERMINATED');expect(receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','AUTHORIZED','TERMINAL']);
  });
  it('shutdown waits for an admission whose durable claim acknowledgement is still pending',async()=>{
    const held=gate(),f=await fixture({async execute(){return null;}}),actual=f.journal.claim;let entered!:()=>void;const started=new Promise<void>(done=>{entered=done;});
    const journal={...f.journal,async claim(...args:Parameters<typeof actual>){const record=await actual(...args);entered();await held.pending;return record;}};
    const core=createRBridgeExecutionCore({...f,journal,subjects:{GITHUB:'example/control:operator',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler:{async execute(){return null;}}});cleanup.unshift(()=>core.close());
    const admitting=core.submit(f.submission(),f.context,new AbortController().signal);await started;let closed=false;const closing=core.close().then(()=>{closed=true;});
    try{await new Promise<void>(done=>setImmediate(done));expect(closed).toBe(false);held.release();await admitting;await closing;expect((await f.journal.get('read-1'))?.receipt.phase).toBe('TERMINAL');}
    finally{held.release();await admitting.catch(()=>undefined);await expect.poll(async()=> (await f.serializer.run('read-1',()=>f.journal.get('read-1')))?.receipt.phase,{timeout:5000}).toBe('TERMINAL');}
  });
});
