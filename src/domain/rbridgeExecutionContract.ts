import {createHash} from 'node:crypto';

export type RBridgeJsonValue=null|boolean|number|string|RBridgeJsonValue[]|{[key:string]:RBridgeJsonValue};
export type RBridgeJsonObject={ [key:string]: RBridgeJsonValue };

export type RBridgeSafeFileAction=
  |'LIST'|'STAT'|'READ'|'READ_MANY'|'READ_BINARY'
  |'WRITE_TEXT'|'WRITE_BINARY'|'APPEND_TEXT'|'EDIT_EXACT'|'MOVE'|'SEARCH';
export type RBridgeSafeProcessAction='START'|'STATUS'|'READ_OUTPUT'|'WRITE_INPUT'|'TERMINATE';
export type RBridgeSafeChunkAction='PUT'|'GET'|'FINALIZE';

export type RBridgeSafeOperation=
  |{kind:'HEALTH';action:'STATUS'}
  |{kind:'FILE';action:RBridgeSafeFileAction;target:string;args:RBridgeJsonObject}
  |{kind:'PROCESS';action:'START';args:RBridgeJsonObject}
  |{kind:'PROCESS';action:Exclude<RBridgeSafeProcessAction,'START'>;sessionId:string;args:RBridgeJsonObject}
  |{kind:'CHUNK';action:RBridgeSafeChunkAction;transferId:string;args:RBridgeJsonObject};

export interface RBridgeOperationSubmissionV1{
  schema:'RBRIDGE_OPERATION_SUBMISSION_V1';
  operationId:string;
  principalId:string;
  targetInstanceId:string;
  operation:RBridgeSafeOperation;
}

export interface RBridgeTransportContextV1{
  schema:'RBRIDGE_TRANSPORT_CONTEXT_V1';
  transport:'GITHUB'|'MCP'|'LOCAL';
  authenticatedSubject:string;
  principalId:string;
  requestRef?:string;
}

export interface RBridgePolicySnapshotV1{
  schema:'RBRIDGE_POLICY_SNAPSHOT_V1';
  mode:'SAFE';
  policyVersion:string;
  policySha256:string;
  decision:'ALLOW'|'BLOCK';
  reason?:string;
}

export type RBridgeExecutionPhase='CLAIMED'|'AUTHORIZED'|'STARTING'|'RUNNING'|'TERMINAL';
export type RBridgeExecutionOutcome='PASS'|'FAIL'|'BLOCKED'|'UNCERTAIN'|'TERMINATED';
export type RBridgeCancelState='NONE'|'REQUESTED'|'PROCESS_PROVEN_STOPPED'|'UNSUPPORTED'|'UNKNOWN';
export type RBridgeSideEffectState='NONE_PROVEN'|'PRESENT'|'ROLLED_BACK'|'UNKNOWN';
export type RBridgePostconditionStatus='PASS'|'FAIL'|'UNKNOWN';

export interface RBridgeExecutionTransitionV1{
  phase:RBridgeExecutionPhase;
  at:string;
}

export interface RBridgePostconditionV1{
  name:string;
  status:RBridgePostconditionStatus;
  evidenceSha256?:string;
}

export interface RBridgeExecutionReceiptV1{
  schema:'RBRIDGE_EXECUTION_RECEIPT_V1';
  operationId:string;
  intentSha256:string;
  principalId:string;
  targetInstanceId:string;
  policy:RBridgePolicySnapshotV1;
  phase:RBridgeExecutionPhase;
  outcome?:RBridgeExecutionOutcome;
  reason?:string;
  resultSha256?:string;
  cancellation:{state:RBridgeCancelState;requestedAt?:string;provenStoppedAt?:string};
  sideEffects:{state:RBridgeSideEffectState};
  transitions:readonly RBridgeExecutionTransitionV1[];
  postconditions:readonly RBridgePostconditionV1[];
}

const ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SESSION_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const TRANSFER_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const FILE_ACTIONS=new Set<RBridgeSafeFileAction>(['LIST','STAT','READ','READ_MANY','READ_BINARY','WRITE_TEXT','WRITE_BINARY','APPEND_TEXT','EDIT_EXACT','MOVE','SEARCH']);
const PROCESS_ACTIONS=new Set<RBridgeSafeProcessAction>(['START','STATUS','READ_OUTPUT','WRITE_INPUT','TERMINATE']);
const CHUNK_ACTIONS=new Set<RBridgeSafeChunkAction>(['PUT','GET','FINALIZE']);
const FORBIDDEN_PROCESS_KEYS=new Set(['executable','executablePath','command','shell']);
const PHASE_TRANSITIONS:Readonly<Record<RBridgeExecutionPhase,readonly RBridgeExecutionPhase[]>>={
  CLAIMED:['AUTHORIZED','TERMINAL'],
  AUTHORIZED:['STARTING','TERMINAL'],
  STARTING:['RUNNING','TERMINAL'],
  RUNNING:['TERMINAL'],
  TERMINAL:[],
};

function fail(code:string):never{throw new Error(code);}
function exact(row:Record<string,unknown>,fields:readonly string[],code:string){const expected=new Set(fields),keys=Object.keys(row);if(keys.length!==expected.size||keys.some(key=>!expected.has(key)))fail(code);}
function record(value:unknown,code:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;}
function id(value:unknown,code:string):string{if(typeof value!=='string'||!ID_RE.test(value))fail(code);return value;}
function jsonValue(value:unknown,code:string):RBridgeJsonValue{
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail(code);return value;}
  if(Array.isArray(value))return value.map(item=>jsonValue(item,code));
  if(value&&typeof value==='object'){
    const out:RBridgeJsonObject={};
    for(const [key,item] of Object.entries(value as Record<string,unknown>)){
      if(!key||key.includes('\0'))fail(code);
      out[key]=jsonValue(item,code);
    }
    return out;
  }
  fail(code);
}
function jsonObject(value:unknown,code:string):RBridgeJsonObject{
  const parsed=jsonValue(value,code);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail(code);
  return parsed as RBridgeJsonObject;
}
function safePath(value:unknown):string{
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\0')||value.length>1024)fail('RBRIDGE_OPERATION_FILE_TARGET_INVALID');
  const parts=value.split('/').slice(1);
  if(parts.some(part=>!part||part==='.'||part==='..'))fail('RBRIDGE_OPERATION_FILE_TARGET_INVALID');
  return value;
}
function canonical(value:RBridgeJsonValue):RBridgeJsonValue{
  if(Array.isArray(value))return value.map(canonical);
  if(value!==null&&typeof value==='object'){
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key]!)]));
  }
  return value;
}
function operation(value:unknown):RBridgeSafeOperation{
  const row=record(value,'RBRIDGE_OPERATION_INVALID');
  const kind=row.kind;
  if(kind==='HEALTH'){
    exact(row,['kind','action'],'RBRIDGE_OPERATION_FIELDS_INVALID');
    if(row.action!=='STATUS')fail('RBRIDGE_OPERATION_HEALTH_ACTION_INVALID');
    return {kind:'HEALTH',action:'STATUS'};
  }
  if(kind==='FILE'){
    exact(row,['kind','action','target','args'],'RBRIDGE_OPERATION_FIELDS_INVALID');
    if(typeof row.action!=='string'||!FILE_ACTIONS.has(row.action as RBridgeSafeFileAction))fail('RBRIDGE_OPERATION_FILE_ACTION_INVALID');
    const args=jsonObject(row.args,'RBRIDGE_OPERATION_ARGS_INVALID');
    if(Object.hasOwn(args,'allowedRoots')||Object.hasOwn(args,'roots'))fail('RBRIDGE_OPERATION_FILE_ROOTS_REQUEST_CONTROLLED');
    return {kind:'FILE',action:row.action as RBridgeSafeFileAction,target:safePath(row.target),args};
  }
  if(kind==='PROCESS'){
    if(typeof row.action!=='string'||!PROCESS_ACTIONS.has(row.action as RBridgeSafeProcessAction))fail('RBRIDGE_OPERATION_PROCESS_ACTION_INVALID');
    const action=row.action as RBridgeSafeProcessAction;
    if(action==='START')exact(row,['kind','action','args'],'RBRIDGE_OPERATION_FIELDS_INVALID');
    else exact(row,['kind','action','sessionId','args'],'RBRIDGE_OPERATION_FIELDS_INVALID');
    const args=jsonObject(row.args,'RBRIDGE_OPERATION_ARGS_INVALID');
    for(const key of FORBIDDEN_PROCESS_KEYS)if(Object.hasOwn(args,key))fail('RBRIDGE_OPERATION_PROCESS_EXECUTABLE_REQUEST_CONTROLLED');
    if(action==='START')return {kind:'PROCESS',action:'START',args};
    if(typeof row.sessionId!=='string'||!SESSION_RE.test(row.sessionId))fail('RBRIDGE_OPERATION_SESSION_ID_INVALID');
    return {kind:'PROCESS',action,sessionId:row.sessionId,args};
  }
  if(kind==='CHUNK'){
    exact(row,['kind','action','transferId','args'],'RBRIDGE_OPERATION_FIELDS_INVALID');
    if(typeof row.action!=='string'||!CHUNK_ACTIONS.has(row.action as RBridgeSafeChunkAction))fail('RBRIDGE_OPERATION_CHUNK_ACTION_INVALID');
    if(typeof row.transferId!=='string'||!TRANSFER_RE.test(row.transferId))fail('RBRIDGE_OPERATION_TRANSFER_ID_INVALID');
    return {kind:'CHUNK',action:row.action as RBridgeSafeChunkAction,transferId:row.transferId,args:jsonObject(row.args,'RBRIDGE_OPERATION_ARGS_INVALID')};
  }
  fail('RBRIDGE_OPERATION_KIND_INVALID');
}

export function parseRBridgeOperationSubmissionV1(value:unknown):RBridgeOperationSubmissionV1{
  const row=record(value,'RBRIDGE_OPERATION_SUBMISSION_INVALID');
  exact(row,['schema','operationId','principalId','targetInstanceId','operation'],'RBRIDGE_OPERATION_SUBMISSION_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_OPERATION_SUBMISSION_V1')fail('RBRIDGE_OPERATION_SUBMISSION_SCHEMA_INVALID');
  return {
    schema:'RBRIDGE_OPERATION_SUBMISSION_V1',
    operationId:id(row.operationId,'RBRIDGE_OPERATION_ID_INVALID'),
    principalId:id(row.principalId,'RBRIDGE_PRINCIPAL_ID_INVALID'),
    targetInstanceId:id(row.targetInstanceId,'RBRIDGE_TARGET_INSTANCE_ID_INVALID'),
    operation:operation(row.operation),
  };
}

export function rbridgeOperationIntentDigest(value:unknown):string{
  const parsed=parseRBridgeOperationSubmissionV1(value);
  const intent:RBridgeJsonValue={
    schema:parsed.schema,
    principalId:parsed.principalId,
    targetInstanceId:parsed.targetInstanceId,
    operation:parsed.operation as unknown as RBridgeJsonValue,
  };
  return createHash('sha256').update(JSON.stringify(canonical(intent))).digest('hex');
}

export function rbridgeOperationScopeDigest(value:unknown):string{
  const parsed=parseRBridgeOperationSubmissionV1(value);
  const scope:RBridgeJsonValue={principalId:parsed.principalId,targetInstanceId:parsed.targetInstanceId};
  return createHash('sha256').update(JSON.stringify(canonical(scope))).digest('hex');
}

export function canTransitionRBridgeExecutionPhase(from:RBridgeExecutionPhase,to:RBridgeExecutionPhase):boolean{
  return PHASE_TRANSITIONS[from].includes(to);
}

export const RBRIDGE_SAFE_CAPABILITY_KINDS=Object.freeze(['HEALTH','FILE','PROCESS','CHUNK'] as const);
