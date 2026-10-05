import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import {type RBridgeJsonValue,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {canAdmitRBridgeOperation,createRBridgeExecutionJournal,type RBridgeOperationRecordV1} from '../../src/server/rbridgeExecutionJournal.js';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
const uid=process.getuid!(),binding={runtimeUid:uid,principalId:'operator',targetInstanceId:'aether'},roots:string[]=[];
const context={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:'operator'} as const;
function submission(id='read-1'):RBridgeOperationSubmissionV1{return {schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:id,principalId:'operator',targetInstanceId:'aether',operation:{kind:'HEALTH',action:'STATUS'}};}
async function fixture(){const root=await mkdtemp(join(homedir(),'.rbridge-journal-test-'));roots.push(root);const serializer=createRBridgeOperationSerializer(),files=createRBridgeStateFiles({checkFilesystem:async()=>undefined}),policy=createRBridgeExecutionPolicy(binding);const journal=await createRBridgeExecutionJournal({root,binding,serializer,files});return {root,serializer,files,policy,journal};}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function claim(f:Awaited<ReturnType<typeof fixture>>,id='read-1'){const s=submission(id);return f.serializer.run(id,()=>f.journal.claim({submission:s,decision:f.policy.evaluate(s),context}));}
function authorized(record:RBridgeOperationRecordV1):RBridgeOperationRecordV1{return {...record,revision:record.revision+1,receipt:{...record.receipt,phase:'AUTHORIZED',transitions:[...record.receipt.transitions,{phase:'AUTHORIZED',at:record.receipt.transitions[0]!.at}]}};}

describe('manifest-bound execution journal',()=>{
  it('accounting predicates reject identity and queue limits independently',()=>{
    const state={identities:0,nonterminal:0,entries:8,journalReservedBytes:128,resultReservedBytes:0};
    expect(canAdmitRBridgeOperation({...state,identities:9999})).toBe(true);
    expect(canAdmitRBridgeOperation({...state,identities:10000})).toBe(false);
    expect(canAdmitRBridgeOperation({...state,nonterminal:127})).toBe(true);
    expect(canAdmitRBridgeOperation({...state,nonterminal:128})).toBe(false);
    expect(canAdmitRBridgeOperation({...state,resultReservedBytes:536870912})).toBe(false);
  });
  it('persists exact identity, original policy and CAS across recreation',async()=>{
    const f=await fixture(),record=await claim(f);expect(record.receipt.phase).toBe('CLAIMED');expect(record.observations.MCP?.count).toBe(1);
    const next=await f.serializer.run('read-1',()=>f.journal.update('read-1',record.revision,authorized(record)));
    expect(next.revision).toBe(2);expect(next.policyDocument).toEqual(f.policy.document);
    const reopened=await createRBridgeExecutionJournal({root:f.root,binding,serializer:f.serializer,files:f.files});expect(await reopened.get('read-1')).toEqual(next);expect(await reopened.recover()).toEqual([next]);
    await expect(f.serializer.run('read-1',()=>f.journal.update('read-1',record.revision,authorized(record)))).rejects.toThrow();
  });
  it('rejects moved or unsafe state without repairing it',async()=>{
    const f=await fixture();await claim(f);const path=join(f.root,'operations','read-1.json'),bytes=await readFile(path);
    await expect(createRBridgeExecutionJournal({root:f.root,binding:{...binding,targetInstanceId:'other'},serializer:f.serializer,files:f.files})).rejects.toThrow();
    const bad=JSON.parse(bytes.toString());bad.submission.operationId='foreign';await writeFile(path,JSON.stringify(bad));const corrupt=await readFile(path);
    await expect(f.journal.get('read-1')).rejects.toThrow();expect(await readFile(path)).toEqual(corrupt);
    await writeFile(path,'{broken');await expect(createRBridgeExecutionJournal({root:f.root,binding,serializer:f.serializer,files:f.files})).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('{broken');
  });
  it('rejects a forged ALLOW snapshot for a disabled action before allocation',async()=>{
    const f=await fixture(),s={...submission(),operation:{kind:'PROCESS',action:'START',args:{}}} as RBridgeOperationSubmissionV1;
    const original=f.policy.evaluate(s),snapshot={...original.snapshot,decision:'ALLOW' as const};delete snapshot.reason;
    await expect(f.serializer.run(s.operationId,()=>f.journal.claim({submission:s,decision:{document:original.document,snapshot},context}))).rejects.toThrow();
    expect(await f.journal.has(s.operationId)).toBe(false);expect(f.journal.capacity().identities).toBe(0);
  });
  it('reserves aggregate capacity atomically and keeps known lookup available',async()=>{
    const f=await fixture();await Promise.all(Array.from({length:32},(_,n)=>claim(f,`read-${n}`)));
    expect(f.journal.capacity().nonterminal).toBe(32);expect(f.journal.capacity().canClaim()).toBe(false);await expect(claim(f,'read-33')).rejects.toThrow('RBRIDGE_CORE_CAPACITY_REACHED');expect(await f.journal.get('read-0')).toBeDefined();
    const reopened=await createRBridgeExecutionJournal({root:f.root,binding,serializer:f.serializer,files:f.files});expect(reopened.capacity().canClaim()).toBe(false);expect(reopened.capacity().nonterminal).toBe(32);
  });
  it('freezes terminal records and validates monotonic history, snapshot and observations',async()=>{
    const f=await fixture();const s={...submission(),operation:{kind:'PROCESS',action:'START',args:{}}} as RBridgeOperationSubmissionV1;
    const record=await f.serializer.run(s.operationId,()=>f.journal.claim({submission:s,decision:f.policy.evaluate(s),context}));
    const terminal:RBridgeOperationRecordV1={...record,revision:2,receipt:{...record.receipt,phase:'TERMINAL',outcome:'BLOCKED',transitions:[...record.receipt.transitions,{phase:'TERMINAL',at:record.receipt.transitions[0]!.at}]}};
    await f.serializer.run(s.operationId,()=>f.journal.update(s.operationId,1,terminal));await expect(f.serializer.run(s.operationId,()=>f.journal.update(s.operationId,2,{...terminal,revision:3}))).rejects.toThrow();
    expect((await f.journal.recover()).length).toBe(0);expect(f.journal.capacity().nonterminal).toBe(0);
    const path=join(f.root,'operations',`${s.operationId}.json`);const bad={...terminal,policyDocument:{...terminal.policyDocument,allowedRoots:['/elsewhere']}};await writeFile(path,canonicalRBridgeJson(bad as unknown as RBridgeJsonValue));await expect(f.journal.get(s.operationId)).rejects.toThrow();
  });
  it('does not return a receipt after a parent fsync failure and accounts retained bytes',async()=>{
    const f=await fixture();const files=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{syncParent:async()=>{throw new Error('disk-failed');}}});
    const broken=await createRBridgeExecutionJournal({root:f.root,binding,serializer:f.serializer,files});
    const s=submission();await expect(f.serializer.run(s.operationId,()=>broken.claim({submission:s,decision:f.policy.evaluate(s),context}))).rejects.toThrow('disk-failed');
    await expect(broken.get(s.operationId)).rejects.toThrow();
    const bytes=await readFile(join(f.root,'operations','read-1.json'));expect(bytes.length).toBeGreaterThan(0);
  });
  it('retains orphan staging bytes in startup accounting',async()=>{
    const f=await fixture();await writeFile(join(f.root,'results','orphan.stage'),Buffer.alloc(1234),{mode:0o600});
    const reopened=await createRBridgeExecutionJournal({root:f.root,binding,serializer:f.serializer,files:f.files});expect(reopened.capacity().resultBytes).toBe(1234);expect(await readFile(join(f.root,'results','orphan.stage'))).toEqual(Buffer.alloc(1234));
    expect(createHash('sha256').update(canonicalRBridgeJson(f.policy.document as unknown as RBridgeJsonValue)).digest('hex')).toBe(f.policy.evaluate(submission()).snapshot.policySha256);
  });
  it('retained result stages remain accounted after canonical replacement',async()=>{
    const f=await fixture();await claim(f);await writeFile(join(f.root,'results','.read-1.json.00000000-0000-0000-0000-000000000000.stage'),'orphan',{mode:0o600});
    await f.journal.rescanAccounting();expect(f.journal.capacity().resultBytes).toBe(6);
    await f.serializer.run('read-1',async()=>{f.journal.assertResultStageFits('read-1',2);await f.files.commit(join(f.root,'results','read-1.json'),Buffer.from('{}'),uid,true);await f.journal.accountResultCommit('read-1',2);});
    expect(f.journal.capacity().resultBytes).toBe(8);expect(await readFile(join(f.root,'results','.read-1.json.00000000-0000-0000-0000-000000000000.stage'),'utf8')).toBe('orphan');
  });
  it('requires the common serializer for claims and updates',async()=>{
    const f=await fixture(),s=submission();await expect(f.journal.claim({submission:s,decision:f.policy.evaluate(s),context})).rejects.toThrow('RBRIDGE_CORE_SERIALIZER_REQUIRED');expect(await f.journal.has(s.operationId)).toBe(false);
  });
});
