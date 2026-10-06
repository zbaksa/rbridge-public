import {mkdtemp,mkdir,writeFile,link,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {flowPilotAppIdentity,flowPilotOperationDigest,type FlowPilotBridgeOperation} from '../../src/domain/flowPilotBridgeProtocol.js';
import {auditFlowPilotGate} from '../../src/installation/flowPilotGate.js';
import {fixtureGateContext} from './fixtureContext.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const actions={APP_PROBE_V1:'COCWIN_FLOWPILOT_APP_PROBE_EVIDENCE_V1',COCWIN_MASTER_POLICY_HEALTH_V1:'COCWIN_FLOWPILOT_MASTER_POLICY_HEALTH_EVIDENCE_V1',COCWIN_REFRESH_SNAPSHOT_V1:'COCWIN_FLOWPILOT_REFRESH_SNAPSHOT_EVIDENCE_V1',COCWIN_CONTINUOUS_QUALIFICATION_V1:'COCWIN_FLOWPILOT_CONTINUOUS_QUALIFICATION_EVIDENCE_V1',COCWIN_DEVELOPMENT_SUPERVISOR_V1:'COCWIN_FLOWPILOT_DEVELOPMENT_SUPERVISOR_EVIDENCE_V1'};
async function fixture(options:{idLength?:number;claim?:boolean;tombstone?:boolean;onlyTombstone?:boolean;stage?:boolean;mode?:number;action?:keyof typeof actions;state?:'SUCCEEDED'|'FAILED'|'BLOCKED'|'UNCERTAIN';mutate?:(row:Record<string,unknown>)=>void;mutateDone?:(row:Record<string,unknown>)=>void}={}){
  const root=await mkdtemp(join(tmpdir(),'rbridge-flowpilot-gate-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'flowpilot');await mkdir(directory,{mode:0o700});
  const action=options.action??'APP_PROBE_V1',operation={schema:'FLOWPILOT_REMOTE_BRIDGE_V1',operationId:'a'.repeat(options.idLength??192),runId:'run',stepId:'step',attempt:1,fencingToken:1,idempotencyKey:'key',timeoutSeconds:30,callbackUrl:'http://127.0.0.1:3000/api/v1/executor/callback',appId:action==='APP_PROBE_V1'?'fpilot':'cocwin',action,payload:action==='COCWIN_MASTER_POLICY_HEALTH_V1'?{expectedPolicySha256:'1'.repeat(64)}:{}} as FlowPilotBridgeOperation;
  const app=flowPilotAppIdentity(operation),state=options.state??'SUCCEEDED',outcome=state==='SUCCEEDED'?'PASS':state==='FAILED'?'FAIL':state==='BLOCKED'?'BLOCKED':'UNKNOWN';
  const evidence={schema:actions[action],appId:app.appId,action,jobId:app.jobId,state,returncode:state==='SUCCEEDED'?0:state==='FAILED'?1:null,timedOut:false,truncated:false,resultSha256:'2'.repeat(64),...(action==='COCWIN_MASTER_POLICY_HEALTH_V1'?{expectedPolicySha256:'1'.repeat(64)}:{})};
  const callback={schema:'FLOWPILOT_CALLBACK_V1',operationId:operation.operationId,fencingToken:1,outcome,evidence,...(outcome==='PASS'?{}:{error:outcome==='FAIL'?'REMOTE_BRIDGE_EXECUTION_FAILED':outcome==='BLOCKED'?'REMOTE_BRIDGE_EXECUTION_BLOCKED':'REMOTE_BRIDGE_EXECUTION_UNCERTAIN'})};
  const row:Record<string,unknown>={schema:'COCWIN_FLOWPILOT_BRIDGE_STORE_V1',operation,digest:flowPilotOperationDigest(operation),...app,phase:'COMPLETED',createdAt:'2026-10-05T00:00:00.000Z',updatedAt:'2026-10-05T00:01:00.000Z',callback};options.mutate?.(row);
  if(!options.onlyTombstone)await writeFile(join(directory,operation.operationId+'.json'),JSON.stringify(row),{mode:0o600});
  if(options.mode!==undefined)await chmod(join(directory,operation.operationId+'.json'),options.mode);
  if(options.stage)await writeFile(join(directory,'interrupted.tmp'),'retained',{mode:0o600});
  if(options.claim)await link(join(directory,operation.operationId+'.json'),join(directory,operation.operationId+'.json.1.claim'));
  if(options.tombstone||options.onlyTombstone){const done:Record<string,unknown>={schema:'COCWIN_FLOWPILOT_BRIDGE_TOMBSTONE_V1',operation,digest:flowPilotOperationDigest(operation),...app,completedAt:row.updatedAt};options.mutateDone?.(done);await writeFile(join(directory,operation.operationId+'.done'),JSON.stringify(done),{mode:0o600});}
  const context=await fixtureGateContext(root);cleanup.push(()=>context.snapshot.close());return {context,row};
}
describe('immutable FlowPilot settlement gate',()=>{
  it('accepts192-character completed identities and rejects193 characters',async()=>{
    for(const idLength of [192,193]){const f=await fixture({idLength});expect((await auditFlowPilotGate(f.context)).status).toBe(idLength===192?'PASS':'BLOCKED');}
  });
  it('two-link claims and disagreeing tombstones block without compaction',async()=>{
    for(const options of [{claim:true},{tombstone:true,mutateDone:(row:Record<string,unknown>)=>{row.completedAt='2026-10-05T00:02:00.000Z';}}]){const f=await fixture(options),before=f.context.snapshot.treeSHA256;expect((await auditFlowPilotGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);}
    const retained=await fixture({tombstone:true});expect((await auditFlowPilotGate(retained.context)).status).toBe('PASS');const compacted=await fixture({onlyTombstone:true});expect((await auditFlowPilotGate(compacted.context)).status).toBe('PASS');
  });
  it('validates all action evidence without claiming result preimage verification',async()=>{
    for(const action of Object.keys(actions) as Array<keyof typeof actions>){const f=await fixture({action}),report=await auditFlowPilotGate(f.context);expect(report.status).toBe('PASS');expect(report.checks).toContainEqual({name:'controller-result-preimages-unavailable',status:'UNKNOWN'});}
  });
  it('retains historical FAIL and BLOCKED outcomes accurately while settled',async()=>{
    for(const state of ['FAILED','BLOCKED'] as const){const f=await fixture({state}),report=await auditFlowPilotGate(f.context);expect(report.status).toBe('PASS');expect(report.checks.some(c=>c.name===`retained-callback-outcome:${state==='FAILED'?'FAIL':'BLOCKED'}:1`)).toBe(true);expect((f.row.callback as Record<string,unknown>).outcome).toBe(state==='FAILED'?'FAIL':'BLOCKED');}
  });
  it('pending, wrong fence, contradictory outcome or unknown callback fields block',async()=>{
    const mutations=[(r:Record<string,unknown>)=>{r.phase='CALLBACK_PENDING';},(r:Record<string,unknown>)=>{(r.callback as Record<string,unknown>).fencingToken=2;},(r:Record<string,unknown>)=>{(r.callback as Record<string,unknown>).outcome='FAIL';},(r:Record<string,unknown>)=>{(r.callback as Record<string,unknown>).unknown=true;}];
    for(const mutate of mutations){const f=await fixture({mutate});expect((await auditFlowPilotGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();}
  });
  it('compares historical expected policy to its callback rather than the current policy',async()=>{
    const f=await fixture({action:'COCWIN_MASTER_POLICY_HEALTH_V1',state:'FAILED',mutate:r=>{
      const op=r.operation as FlowPilotBridgeOperation;if(op.action!=='COCWIN_MASTER_POLICY_HEALTH_V1')throw Error('fixture');op.payload.expectedPolicySha256='f'.repeat(64);r.digest=flowPilotOperationDigest(op);
      ((r.callback as Record<string,unknown>).evidence as Record<string,unknown>).expectedPolicySha256='f'.repeat(64);
    }});
    expect((await auditFlowPilotGate(f.context)).status).toBe('PASS');
  });
  it('stage, foreign mode and action-specific evidence drift block unchanged',async()=>{
    for(const options of [{stage:true},{mode:0o640},{action:'COCWIN_MASTER_POLICY_HEALTH_V1' as const,mutate:(r:Record<string,unknown>)=>{((r.callback as Record<string,unknown>).evidence as Record<string,unknown>).expectedPolicySha256='f'.repeat(64);}}]){
      const f=await fixture(options),before=f.context.snapshot.treeSHA256;expect((await auditFlowPilotGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);
    }
  });
});
