import {performance} from 'node:perf_hooks';
import {flowPilotAppIdentity,flowPilotOperationDigest,type FlowPilotBridgeOperation} from '../domain/flowPilotBridgeProtocol.js';
import {gateReport,installHash,type GateContext} from './gateContext.js';
import {parseStrictJson} from './strictJson.js';
import type {Check,GateReport} from './types.js';

const ID=/^[a-z0-9][a-z0-9._:-]{0,191}$/,HASH=/^[0-9a-f]{64}$/;
const evidenceSchemas={APP_PROBE_V1:'COCWIN_FLOWPILOT_APP_PROBE_EVIDENCE_V1',COCWIN_MASTER_POLICY_HEALTH_V1:'COCWIN_FLOWPILOT_MASTER_POLICY_HEALTH_EVIDENCE_V1',COCWIN_REFRESH_SNAPSHOT_V1:'COCWIN_FLOWPILOT_REFRESH_SNAPSHOT_EVIDENCE_V1',COCWIN_CONTINUOUS_QUALIFICATION_V1:'COCWIN_FLOWPILOT_CONTINUOUS_QUALIFICATION_EVIDENCE_V1',COCWIN_DEVELOPMENT_SUPERVISOR_V1:'COCWIN_FLOWPILOT_DEVELOPMENT_SUPERVISOR_EVIDENCE_V1'};
function fail(reason:string):never{throw new Error(reason);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('FLOWPILOT_RECORD_INVALID');return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]){if(required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...required,...optional].includes(k)))fail('FLOWPILOT_FIELDS_INVALID');}
function date(value:unknown):number{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('FLOWPILOT_TIMESTAMP_INVALID');return Date.parse(value);}
function integer(value:unknown,min:number,max:number){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;}
function secret(value:unknown):boolean{if(Array.isArray(value))return value.some(secret);if(value&&typeof value==='object')return Object.entries(value).some(([key,v])=>(key!=='fencingToken'&&/(authorization|bearer|token|secret|password|passwd|cookie)/i.test(key))||secret(v));return false;}
function operation(value:unknown):FlowPilotBridgeOperation{
  const op=object(value);fields(op,['schema','operationId','runId','stepId','attempt','fencingToken','idempotencyKey','appId','action','payload','timeoutSeconds','callbackUrl']);
  if(op.schema!=='FLOWPILOT_REMOTE_BRIDGE_V1'||['operationId','runId','stepId','idempotencyKey'].some(k=>typeof op[k]!=='string'||!ID.test(String(op[k])))||!integer(op.attempt,1,10)||!integer(op.fencingToken,1,Number.MAX_SAFE_INTEGER)||!integer(op.timeoutSeconds,1,1800)||typeof op.callbackUrl!=='string')fail('FLOWPILOT_OPERATION_INVALID');
  const payload=object(op.payload),action=String(op.action);
  if(!Object.hasOwn(evidenceSchemas,action)||(action==='APP_PROBE_V1'?op.appId!=='fpilot':op.appId!=='cocwin'))fail('FLOWPILOT_ACTION_INVALID');
  if(action==='COCWIN_MASTER_POLICY_HEALTH_V1'){
    fields(payload,['expectedPolicySha256']);if(typeof payload.expectedPolicySha256!=='string'||!HASH.test(payload.expectedPolicySha256))fail('FLOWPILOT_POLICY_MISMATCH');
  }else fields(payload,[]);
  let url:URL;try{url=new URL(op.callbackUrl);}catch{fail('FLOWPILOT_CALLBACK_URL_INVALID');}
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/api/v1/executor/callback'||url.search||url.hash)fail('FLOWPILOT_CALLBACK_URL_INVALID');
  return op as unknown as FlowPilotBridgeOperation;
}
function callback(value:unknown,op:FlowPilotBridgeOperation,app:{appId:string;jobId:string}):string{
  const row=object(value);fields(row,['schema','operationId','fencingToken','outcome','evidence'],['error']);
  if(row.schema!=='FLOWPILOT_CALLBACK_V1'||row.operationId!==op.operationId||row.fencingToken!==op.fencingToken||!['PASS','FAIL','BLOCKED','UNKNOWN'].includes(String(row.outcome)))fail('FLOWPILOT_CALLBACK_IDENTITY_INVALID');
  const e=object(row.evidence);fields(e,['schema','appId','action','jobId','state','returncode','timedOut','truncated','resultSha256'],op.action==='COCWIN_MASTER_POLICY_HEALTH_V1'?['expectedPolicySha256']:[]);
  if(e.schema!==evidenceSchemas[op.action]||e.appId!==app.appId||e.jobId!==app.jobId||e.action!==op.action||!['SUCCEEDED','FAILED','BLOCKED','UNCERTAIN'].includes(String(e.state))||(e.returncode!==null&&!integer(e.returncode,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))||typeof e.timedOut!=='boolean'||typeof e.truncated!=='boolean'||typeof e.resultSha256!=='string'||!HASH.test(e.resultSha256))fail('FLOWPILOT_CALLBACK_EVIDENCE_INVALID');
  if(op.action==='COCWIN_MASTER_POLICY_HEALTH_V1'&&e.expectedPolicySha256!==op.payload.expectedPolicySha256)fail('FLOWPILOT_POLICY_MISMATCH');
  const outcome=e.timedOut||e.truncated||e.state==='UNCERTAIN'?'UNKNOWN':e.state==='SUCCEEDED'?'PASS':e.state==='FAILED'?'FAIL':'BLOCKED';
  const error=outcome==='PASS'?undefined:outcome==='FAIL'?'REMOTE_BRIDGE_EXECUTION_FAILED':outcome==='BLOCKED'?'REMOTE_BRIDGE_EXECUTION_BLOCKED':'REMOTE_BRIDGE_EXECUTION_UNCERTAIN';
  if(row.outcome!==outcome||row.error!==error||(outcome==='PASS'&&Object.hasOwn(row,'error')))fail('FLOWPILOT_CALLBACK_OUTCOME_MISMATCH');
  return outcome;
}
interface History{operation:FlowPilotBridgeOperation;digest:string;appId:string;jobId:string;completedAt:string;outcome?:string;}
function history(value:unknown,tombstone:boolean,id:string):History{
  const row=object(value);fields(row,tombstone?['schema','operation','digest','appId','jobId','completedAt']:['schema','operation','digest','appId','jobId','phase','createdAt','updatedAt'],tombstone?[]:['callback']);
  if(secret(row)||row.schema!==(tombstone?'COCWIN_FLOWPILOT_BRIDGE_TOMBSTONE_V1':'COCWIN_FLOWPILOT_BRIDGE_STORE_V1'))fail('FLOWPILOT_RECORD_INVALID');
  const op=operation(row.operation),app=flowPilotAppIdentity(op),digest=flowPilotOperationDigest(op);
  if(op.operationId!==id||row.digest!==digest||row.appId!==app.appId||row.jobId!==app.jobId)fail('FLOWPILOT_OPERATION_MAPPING_MISMATCH');
  const completedAt=tombstone?row.completedAt:row.updatedAt;date(completedAt);
  let outcome:string|undefined;
  if(!tombstone){
    if(!['CLAIMED','SUBMITTED','CALLBACK_PENDING','COMPLETED'].includes(String(row.phase)))fail('FLOWPILOT_PHASE_INVALID');
    if(date(row.updatedAt)<date(row.createdAt))fail('FLOWPILOT_TIMESTAMP_ORDER');
    if(['CALLBACK_PENDING','COMPLETED'].includes(String(row.phase))!==Object.hasOwn(row,'callback'))fail('FLOWPILOT_PHASE_CALLBACK_MISMATCH');
    if(row.phase!=='COMPLETED')fail('FLOWPILOT_PENDING_WORK');
    outcome=callback(row.callback,op,app);
  }
  return {operation:op,digest,...app,completedAt:completedAt as string,...(outcome?{outcome}:{})};
}

export async function auditFlowPilotGate(context:GateContext):Promise<GateReport>{
  const evidence:Array<{path:string;sha256:string;outcome:string;preimage:string}>=[],started=performance.now();
  try{
    await context.snapshot.verify();
    if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes)fail('FLOWPILOT_SNAPSHOT_MISMATCH');
    if(context.snapshot.reasonCodes.length)return gateReport(context,'FLOWPILOT','BLOCKED',context.snapshot.reasonCodes);
    const root=context.snapshot.entries.find(e=>e.path==='flowpilot');
    if(root&&(root.kind!=='DIRECTORY'||root.mode!==0o700))fail('FLOWPILOT_DIRECTORY_INVALID');
    const records=new Map<string,History>(),tombstones=new Map<string,History>(),outcomes=new Map<string,number>();
    for(const entry of context.snapshot.entries.filter(e=>e.path.startsWith('flowpilot/'))){
      if(performance.now()-started>=context.profile.budget.scan_ms)fail('FLOWPILOT_SCAN_DEADLINE');
      const name=entry.path.slice('flowpilot/'.length),match=/^(.+)\.(json|done)$/.exec(name);
      if(!match||!ID.test(match[1]!)||entry.kind!=='FILE'||entry.mode!==0o600||entry.nlink!==1||entry.size>context.profile.budget.record_bytes)fail('FLOWPILOT_UNKNOWN_OR_INTERRUPTED_ENTRY');
      const done=match[2]==='done',row=history(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(await context.snapshot.read(entry.path))),done,match[1]!);
      (done?tombstones:records).set(match[1]!,row);
      if(row.outcome)outcomes.set(row.outcome,(outcomes.get(row.outcome)??0)+1);
      evidence.push({path:entry.path,sha256:entry.sha256,outcome:row.outcome??'NOT_RETAINED',preimage:'NOT_AVAILABLE'});
    }
    for(const [id,done] of tombstones){
      const row=records.get(id);if(row&&installHash({...row,outcome:null})!==installHash({...done,outcome:null}))fail('FLOWPILOT_TOMBSTONE_DISAGREES');
    }
    await context.snapshot.verify();
    const checks:Check[]=[{name:'complete-settled-record-and-tombstone-correlation',status:'PASS',evidence_sha256:installHash(evidence)}];
    for(const [outcome,count] of [...outcomes].sort())checks.push({name:`retained-callback-outcome:${outcome}:${count}`,status:'PASS'});
    // Settlement PASS does not claim controller-result bytes that this store never retained.
    if(evidence.length)checks.push({name:'controller-result-preimages-unavailable',status:'UNKNOWN'});
    return gateReport(context,'FLOWPILOT','PASS',[],checks,evidence);
  }catch(error){
    const reason=error instanceof Error&&/^(?:FLOWPILOT|STATE|INSTALL_JSON)_[A-Z_]+$/.test(error.message)?error.message:'FLOWPILOT_PARSE_OR_SNAPSHOT_UNAVAILABLE';
    return gateReport(context,'FLOWPILOT',reason.startsWith('STATE_')?'UNKNOWN':'BLOCKED',[reason],[],evidence);
  }
}
