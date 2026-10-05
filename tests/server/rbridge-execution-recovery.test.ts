import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import type {RBridgeExecutionReceiptV1,RBridgeJsonValue,RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionCore,type RBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionJournal} from '../../src/server/rbridgeExecutionJournal.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {evaluateRBridgePolicyDocument,type RBridgeExecutionPolicy,type RBridgePolicyDocumentV1} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeReadonlyHandlers,type RBridgeReadonlyHandler} from '../../src/server/rbridgeReadonlyHandlers.js';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';
const cleanup:Array<()=>Promise<unknown>>=[],sources:string[]=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run().catch(()=>undefined);await cleanupRBridgeTestStates();await Promise.all(sources.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const f=await createRBridgeTestState(),sourceRoot=await mkdtemp(join(homedir(),'.rbridge-recover-source-'));sources.push(sourceRoot);await writeFile(join(sourceRoot,'source.txt'),'before');return {...f,sourceRoot};}
async function coreFor(f:Awaited<ReturnType<typeof fixture>>,handler:RBridgeReadonlyHandler={async execute(){return {observed:'new'};}},policy:RBridgeExecutionPolicy=f.policy){
  const results=await createRBridgeExecutionResults(f),core=createRBridgeExecutionCore({...f,results,policy,subjects:{GITHUB:'example/control:operator',MCP:`uid:${f.uid}`},legacyReservations:{async isReserved(){return false;}},handler});cleanup.push(()=>core.close());return {core,results};
}
async function terminal(core:RBridgeExecutionCore,f:Awaited<ReturnType<typeof fixture>>):Promise<RBridgeExecutionReceiptV1>{const until=Date.now()+5000;while(Date.now()<until){const reply=await core.status('read-1',f.context);if(reply.status==='RECEIPT'&&reply.receipt.phase==='TERMINAL')return reply.receipt;await new Promise<void>(done=>setTimeout(done,5));}throw new Error('RECOVERY_DEADLINE');}
function tightened(f:Awaited<ReturnType<typeof fixture>>):RBridgeExecutionPolicy{const document:RBridgePolicyDocumentV1={...f.policy.document,enabledActions:[]};return {document,evaluate:s=>evaluateRBridgePolicyDocument(document,s)};}
async function killAt(f:Awaited<ReturnType<typeof fixture>>,point:string){
  const child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/rbridge-crash-owner.ts'),f.root,f.sourceRoot,point],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=String(chunk);});child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const exited=new Promise<void>((done,reject)=>{child.once('close',()=>done());child.once('error',reject);});
  try{const until=Date.now()+5000;while(!stdout.includes('\n')&&child.exitCode===null&&Date.now()<until)await new Promise<void>(done=>setTimeout(done,5));if(!stdout.includes('\n'))throw new Error('CRASH_CHECKPOINT_MISSING '+stderr);expect(JSON.parse(stdout.trim())).toMatchObject({schema:'RBRIDGE_CRASH_CHECKPOINT_V1',checkpoint:point});child.kill('SIGKILL');await exited;expect(child.signalCode).toBe('SIGKILL');}
  finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
}
describe('monotonic interrupted read recovery',()=>{
  it('terminal recovery never calls a handler or changes terminal record/output bytes',async()=>{
    const f=await fixture(),record=await f.running(),results=await createRBridgeExecutionResults(f),output=await f.serializer.run('read-1',()=>results.commit('read-1',{old:'observation'}));await f.transition(record,'TERMINAL',{outcome:'PASS',resultSha256:output.sha256});const before=await readFile(join(f.root,'operations','read-1.json')),oldOutput=await readFile(join(f.root,'results','read-1.json'));let calls=0;
    const {core}=await coreFor(f,{async execute(){calls++;throw new Error('TERMINAL_MUST_NOT_RUN');}},tightened(f));await core.recover();await core.recover();expect(calls).toBe(0);expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(before);expect(await readFile(join(f.root,'results','read-1.json'))).toEqual(oldOutput);expect((await terminal(core,f)).outcome).toBe('PASS');
  });
  it.each(['CLAIMED','AUTHORIZED','STARTING','RUNNING'] as const)('incomplete reads reobserve without repeating durable phase transitions (%s)',async phase=>{
    const f=await fixture();let record=await f.claim();for(const next of ['AUTHORIZED','STARTING','RUNNING'] as const){if(record.receipt.phase===phase)break;record=await f.transition(record,next);}let calls=0;const {core}=await coreFor(f,{async execute(){calls++;return {observed:'replacement'};}});await core.recover();const recovered=await terminal(core,f);expect(recovered.outcome).toBe('PASS');expect(recovered.transitions.map(t=>t.phase)).toEqual(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL']);expect(recovered.policy).toEqual(record.receipt.policy);expect(calls).toBe(1);expect(f.journal.capacity().identities).toBe(1);
  });
  it('finishes an original policy BLOCK CLAIMED using the unchanged short path',async()=>{
    const f=await fixture(),submission:RBridgeOperationSubmissionV1={...f.submission(),operation:{kind:'PROCESS',action:'START',args:{}}};const record=await f.serializer.run('read-1',()=>f.journal.claim({submission,decision:f.policy.evaluate(submission),context:f.context}));let calls=0;const {core}=await coreFor(f,{async execute(){calls++;return null;}});await core.recover();const receipt=await terminal(core,f);expect(receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','TERMINAL']);expect(receipt.outcome).toBe('BLOCKED');expect(receipt.policy).toEqual(record.receipt.policy);expect(calls).toBe(0);
  });
  it.each(['CLAIMED','RUNNING'] as const)('applies current restrictions while retaining original ALLOW evidence (%s)',async phase=>{
    const f=await fixture(),record=phase==='CLAIMED'?await f.claim():await f.running(),policy=tightened(f);let calls=0;const {core}=await coreFor(f,{async execute(){calls++;return null;}},policy);await core.recover();const receipt=await terminal(core,f);expect(receipt.outcome).toBe('BLOCKED');expect(receipt.reason).toBe('RBRIDGE_CORE_CURRENT_POLICY_RESTRICTED');expect(receipt.policy).toEqual(record.receipt.policy);expect(receipt.transitions.map(t=>t.phase)).toEqual(phase==='CLAIMED'?['CLAIMED','AUTHORIZED','TERMINAL']:['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL']);expect(receipt.postconditions).toContainEqual({name:'current-policy-restriction',status:'PASS',evidenceSha256:createHash('sha256').update(canonicalRBridgeJson(policy.evaluate(record.submission).snapshot as unknown as RBridgeJsonValue)).digest('hex')});expect(calls).toBe(0);
  });
  it('retains corrupted records without any reexecution',async()=>{
    const f=await fixture();await f.claim();const path=join(f.root,'operations','read-1.json');await writeFile(path,'{corrupt');let calls=0;const {core}=await coreFor(f,{async execute(){calls++;return null;}});await expect(core.recover()).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('{corrupt');expect(calls).toBe(0);
  });
  it.each(['missing','corrupt'])('does not rerun terminal work when its retained output is %s',async mode=>{
    const f=await fixture(),record=await f.running(),results=await createRBridgeExecutionResults(f),output=await f.serializer.run('read-1',()=>results.commit('read-1',{original:true}));await f.transition(record,'TERMINAL',{outcome:'PASS',resultSha256:output.sha256});const path=join(f.root,'results','read-1.json'),before=await readFile(join(f.root,'operations','read-1.json'));
    if(mode==='missing')await rm(path);else await writeFile(path,'corrupt');let calls=0;const {core}=await coreFor(f,{async execute(){calls++;return null;}});await core.recover();await expect(core.result('read-1',0,16,f.context)).rejects.toThrow(/RESULT_UNAVAILABLE|DIGEST_MISMATCH/);expect(calls).toBe(0);expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(before);
  });
  it('keeps a failed terminal commit nonterminal on disk and lets a fresh owner reobserve',async()=>{
    const f=await fixture(),files=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{async beforePlacement(){throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}}});let record=await f.running();const broken=await createRBridgeExecutionJournal({...f,files});const next={...record,revision:record.revision+1,receipt:{...record.receipt,phase:'TERMINAL' as const,outcome:'FAIL' as const,transitions:[...record.receipt.transitions,{phase:'TERMINAL' as const,at:record.receipt.transitions.at(-1)!.at}]}};
    await expect(f.serializer.run('read-1',()=>broken.update('read-1',record.revision,next))).rejects.toThrow('disk full');expect((await f.journal.get('read-1'))?.receipt.phase).toBe('RUNNING');expect((await readdir(join(f.root,'operations'))).some(name=>name.endsWith('.stage'))).toBe(true);
    const journal=await createRBridgeExecutionJournal({...f,files:f.files}),replacement={...f,journal};const {core}=await coreFor(replacement);await core.recover();record=(await journal.get('read-1'))!;expect((await terminal(core,replacement)).outcome).toBe('PASS');expect(record.receipt.policy).toEqual(f.policy.evaluate(record.submission).snapshot);
  });
  it.each(['CLAIMED','AUTHORIZED','STARTING','RUNNING','RESULT_FSYNC','RESULT_PLACED','TERMINAL_BEFORE','TERMINAL'])('real SIGKILL at %s preserves truth and replacement reads actual changed bytes',async point=>{
    const f=await fixture();await killAt(f,point);const before=await readFile(join(f.root,'operations','read-1.json')),previous=(await f.journal.get('read-1'))!,isTerminal=previous.receipt.phase==='TERMINAL';await writeFile(join(f.sourceRoot,'source.txt'),'after');
    const owner=await acquireRBridgeOwnerLock({root:f.root,uid:f.uid,files:f.files});cleanup.push(()=>owner.close());const journal=await createRBridgeExecutionJournal(f),replacement={...f,journal},readonly=createRBridgeReadonlyHandlers({policy:f.policy,sourceRoot:f.sourceRoot,health:{snapshot:()=>({})}});let calls=0;const {core}=await coreFor(replacement,{async execute(...args){calls++;return readonly.execute(...args);}});await core.recover();const receipt=await terminal(core,replacement),page=await core.result('read-1',0,32768,f.context);expect(receipt.outcome).toBe('PASS');expect(page.status).toBe('RESULT');if(page.status!=='RESULT')throw new Error('NO_OUTPUT');expect(JSON.parse(Buffer.from(page.dataBase64,'base64').toString())).toEqual({path:'/mnt/data/source.txt',text:isTerminal?'before':'after'});expect(calls).toBe(isTerminal?0:1);if(isTerminal)expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(before);expect(journal.capacity().identities).toBe(1);
  },15000);
});
