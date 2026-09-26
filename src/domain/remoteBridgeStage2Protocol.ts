import {createHash} from 'node:crypto';

export type RemoteBridgeStage2Operation =
  | {kind:'APP_RUN'; appId:string; jobId:string; payload:AppExecutionPayload}
  | {kind:'FILE'; action:'LIST'|'STAT'|'READ'|'READ_MANY'|'WRITE_TEXT'|'APPEND_TEXT'|'EDIT_EXACT'|'MOVE'|'SEARCH'; target:string; args:Record<string,unknown>}
  | {kind:'PROCESS'; action:'START'|'STATUS'|'READ_OUTPUT'|'WRITE_INPUT'|'TERMINATE'; sessionId?:string; args:Record<string,unknown>}
  | {kind:'CHUNK'; action:'PUT'|'GET'|'FINALIZE'; transferId:string; args:Record<string,unknown>}
  | {kind:'HEALTH'; action:'STATUS'};

export type RemoteBridgeRequestV2 = {
  schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2';
  requestId:string;
  createdAt:string;
  expiresAt:string;
  operation:RemoteBridgeStage2Operation;
};

type AppExecutionPayload = {tool:'node'|'npm'|'git'|'opencode'|'verify'|'probe'; cwd:string; args:string[]; timeout_ms:number; max_bytes:number;};

const REQUEST_PREFIX='[COCWIN BRIDGE REQUEST] ';
const REQUEST_ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const APP_RE=/^[a-z][a-z0-9_-]{0,31}$/;
const JOB_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY_BYTES=65_536, MAX_TTL_MS=30*60*1000, MAX_FUTURE_SKEW_MS=2*60*1000;
const TOP_FIELDS=new Set(['schema','requestId','createdAt','expiresAt','operation']);
const APP_RUN_FIELDS=new Set(['kind','appId','jobId','payload']);
const FILE_FIELDS=new Set(['kind','action','target','args']);
const PROCESS_START_FIELDS=new Set(['kind','action','args']);
const PROCESS_SESSION_FIELDS=new Set(['kind','action','args','sessionId']);
const CHUNK_FIELDS=new Set(['kind','action','transferId','args']);
const HEALTH_FIELDS=new Set(['kind','action']);

const FILE_ACTIONS=new Set(['LIST','STAT','READ','READ_MANY','WRITE_TEXT','APPEND_TEXT','EDIT_EXACT','MOVE','SEARCH']);
const PROCESS_ACTIONS=new Set(['START','STATUS','READ_OUTPUT','WRITE_INPUT','TERMINATE']);
const CHUNK_ACTIONS=new Set(['PUT','GET','FINALIZE']);

function fail(code:string):never{throw new Error(code);}
function record(value:unknown,code:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;}
function exactFields(row:Record<string,unknown>,fields:Set<string>,code:string):void{const keys=Object.keys(row);if(keys.length!==fields.size||keys.some(key=>!fields.has(key)))fail(code);}
function integer(value:unknown,min:number,max:number,code:string):number{if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;}
function iso(value:unknown,code:string):{raw:string;ms:number}{if(typeof value!=='string')fail(code);const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail(code);return {raw:value,ms};}
function cwd(value:unknown):string{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.length>1024||/\s|\0/.test(value))fail('REMOTE_BRIDGE_CWD_INVALID');const parts=value.split('/').slice(1);if(parts.some(part=>!part||part==='.'||part==='..'))fail('REMOTE_BRIDGE_CWD_INVALID');return value;}
function args(value:unknown,tool:'node'|'npm'|'git'|'opencode'|'verify'|'probe'):string[]{if(!Array.isArray(value)||value.length>256)fail('REMOTE_BRIDGE_ARGS_INVALID');let total=0;for(let i=0;i<value.length;i++){const arg=value[i];if(typeof arg!=='string'||arg.includes('\0'))fail('REMOTE_BRIDGE_ARGS_INVALID');const bytes=Buffer.byteLength(arg);const limit=tool==='opencode'&&i===value.length-1?24*1024:8192;if(bytes>limit)fail('REMOTE_BRIDGE_ARGS_INVALID');total+=bytes;}if(total>32768)fail('REMOTE_BRIDGE_ARGS_INVALID');return [...value] as string[];}
function validateAppId(appId:string):void{if(typeof appId!=='string'||!APP_RE.test(appId))fail('REMOTE_BRIDGE_V2_APP_ID_INVALID');}
function validateJobId(jobId:string):void{if(typeof jobId!=='string'||!JOB_RE.test(jobId))fail('REMOTE_BRIDGE_V2_JOB_ID_INVALID');}
function isSafePath(path:unknown):boolean{if(typeof path!=='string'||path.length>1024||path.startsWith('//')||/\s|\0/.test(path))return false;const parts=path.split('/').slice(1);if(parts.some(part=>!part||part==='.'||part==='..'))return false;return path.startsWith('/');}
function validateProcessSessionId(id:unknown):void{if(typeof id!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(id))fail('REMOTE_BRIDGE_V2_SESSION_ID_INVALID');}

export function parseRemoteBridgeRequestV2(input:{title:string;body:string;author:string;repository:string;now:Date}):RemoteBridgeRequestV2{
  if(input.author!=='zbaksa')fail('REMOTE_BRIDGE_V2_AUTHOR_INVALID');
  if(input.repository!=='zbaksa/cocwin-private')fail('REMOTE_BRIDGE_V2_REPOSITORY_INVALID');
  if(typeof input.title!=='string'||!input.title.startsWith(REQUEST_PREFIX))fail('REMOTE_BRIDGE_V2_TITLE_INVALID');
  if(typeof input.body!=='string'||Buffer.byteLength(input.body)>MAX_BODY_BYTES)fail('REMOTE_BRIDGE_V2_BODY_TOO_LARGE');
  let parsed:unknown;try{parsed=JSON.parse(input.body);}catch{fail('REMOTE_BRIDGE_V2_BODY_JSON_INVALID');}
  const row=record(parsed,'REMOTE_BRIDGE_V2_BODY_INVALID');
  exactFields(row,TOP_FIELDS,'REMOTE_BRIDGE_V2_FIELDS_INVALID');
  if(row.schema!=='COCWIN_REMOTE_BRIDGE_REQUEST_V2')fail('REMOTE_BRIDGE_V2_SCHEMA_INVALID');
  if(typeof row.requestId!=='string'||!REQUEST_ID_RE.test(row.requestId))fail('REMOTE_BRIDGE_V2_REQUEST_ID_INVALID');
  if(input.title!==REQUEST_PREFIX+row.requestId)fail('REMOTE_BRIDGE_V2_TITLE_REQUEST_ID_MISMATCH');
  const created=iso(row.createdAt,'REMOTE_BRIDGE_V2_CREATED_AT_INVALID'),expires=iso(row.expiresAt,'REMOTE_BRIDGE_V2_EXPIRES_AT_INVALID');
  if(expires.ms<=created.ms)fail('REMOTE_BRIDGE_V2_TIME_ORDER_INVALID');
  if(expires.ms-created.ms>MAX_TTL_MS)fail('REMOTE_BRIDGE_V2_TTL_INVALID');
  const now=input.now??new Date();const nowMs=now.getTime();if(!Number.isFinite(nowMs))fail("REMOTE_BRIDGE_V2_NOW_INVALID");if(created.ms>nowMs+MAX_FUTURE_SKEW_MS)fail("REMOTE_BRIDGE_V2_CREATED_AT_FUTURE");if(expires.ms<=nowMs)fail("REMOTE_BRIDGE_V2_REQUEST_EXPIRED");
  const operation=record(row.operation,'REMOTE_BRIDGE_V2_OPERATION_INVALID');
  if(operation.kind==='APP_RUN'){
    exactFields(operation,APP_RUN_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');
    if(typeof operation.appId!=='string')fail('REMOTE_BRIDGE_V2_APP_ID_INVALID');
    if(typeof operation.jobId!=='string')fail('REMOTE_BRIDGE_V2_JOB_ID_INVALID');
    validateAppId(operation.appId);validateJobId(operation.jobId);
    const payload=record(operation.payload,'REMOTE_BRIDGE_V2_APP_PAYLOAD_INVALID') as unknown as AppExecutionPayload;
    const PAYLOAD_FIELDS=new Set(['tool','cwd','args','timeout_ms','max_bytes']);
    exactFields(payload as unknown as Record<string,unknown>,PAYLOAD_FIELDS,'REMOTE_BRIDGE_V2_APP_PAYLOAD_FIELDS_INVALID');
    if(typeof payload.tool!=='string'||!['node','npm','git','opencode','verify','probe'].includes(payload.tool))fail('REMOTE_BRIDGE_V2_APP_TOOL_INVALID');
    const tool=payload.tool as 'node'|'npm'|'git'|'opencode'|'verify'|'probe';
    const validatedPayload={tool,cwd:cwd(payload.cwd),args:args(payload.args,tool),timeout_ms:integer(payload.timeout_ms,1000,1_800_000,'REMOTE_BRIDGE_V2_TIMEOUT_INVALID'),max_bytes:integer(payload.max_bytes,4096,1_048_576,'REMOTE_BRIDGE_V2_MAX_BYTES_INVALID')};
    return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:row.requestId as string,createdAt:created.raw,expiresAt:expires.raw,operation:{kind:'APP_RUN',appId:operation.appId,jobId:operation.jobId,payload:validatedPayload}};
  }else if(operation.kind==='FILE'){
    exactFields(operation,FILE_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');
    if(typeof operation.action!=='string'||!FILE_ACTIONS.has(operation.action))fail('REMOTE_BRIDGE_V2_FILE_ACTION_INVALID');
    if(typeof operation.target!=='string'||!isSafePath(operation.target))fail('REMOTE_BRIDGE_V2_FILE_TARGET_INVALID');
    const fileArgs=record(operation.args,'REMOTE_BRIDGE_V2_FILE_ARGS_INVALID');
    if(Object.hasOwn(fileArgs,'allowedRoots')||Object.hasOwn(fileArgs,'roots'))fail('REMOTE_BRIDGE_V2_FILE_ROOTS_REQUEST_CONTROLLED');
    return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:row.requestId as string,createdAt:created.raw,expiresAt:expires.raw,operation:{kind:'FILE',action:operation.action as Extract<RemoteBridgeStage2Operation,{kind:'FILE'}>['action'],target:operation.target,args:{...fileArgs}}};
  }else if(operation.kind==='PROCESS'){
    if(typeof operation.action!=='string'||!PROCESS_ACTIONS.has(operation.action))fail('REMOTE_BRIDGE_V2_PROCESS_ACTION_INVALID');
    const action=operation.action as Extract<RemoteBridgeStage2Operation,{kind:'PROCESS'}>['action'];
    if(action==='START')exactFields(operation,PROCESS_START_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');else exactFields(operation,PROCESS_SESSION_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');
    const processArgs=record(operation.args,'REMOTE_BRIDGE_V2_PROCESS_ARGS_INVALID');
    if(action==='START'&&(Object.hasOwn(processArgs,'executable')||Object.hasOwn(processArgs,'executablePath')))fail('REMOTE_BRIDGE_V2_PROCESS_EXECUTABLE_REQUEST_CONTROLLED');
    const processOperation:RemoteBridgeStage2Operation=action==='START'?{kind:'PROCESS',action:'START',args:{...processArgs}}:{kind:'PROCESS',action,sessionId:(()=>{validateProcessSessionId(operation.sessionId);return operation.sessionId as string})(),args:{...processArgs}};
    return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:row.requestId as string,createdAt:created.raw,expiresAt:expires.raw,operation:processOperation};
  }else if(operation.kind==='CHUNK'){
    exactFields(operation,CHUNK_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');
    if(typeof operation.action!=='string'||!CHUNK_ACTIONS.has(operation.action))fail('REMOTE_BRIDGE_V2_CHUNK_ACTION_INVALID');
    if(typeof operation.transferId!=='string'||operation.transferId.length>128||!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(operation.transferId))fail('REMOTE_BRIDGE_V2_TRANSFER_ID_INVALID');
    const chunkArgs=record(operation.args,'REMOTE_BRIDGE_V2_CHUNK_ARGS_INVALID');
    return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:row.requestId as string,createdAt:created.raw,expiresAt:expires.raw,operation:{kind:'CHUNK',action:operation.action as Extract<RemoteBridgeStage2Operation,{kind:'CHUNK'}>['action'],transferId:operation.transferId,args:{...chunkArgs}}};
  }else if(operation.kind==='HEALTH'){
    exactFields(operation,HEALTH_FIELDS,'REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID');
    if(operation.action!=='STATUS')fail('REMOTE_BRIDGE_V2_HEALTH_ACTION_INVALID');
    return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:row.requestId as string,createdAt:created.raw,expiresAt:expires.raw,operation:{kind:'HEALTH',action:'STATUS'}};
  }
  fail('REMOTE_BRIDGE_V2_OPERATION_KIND_INVALID');
}

function canonicalSemantic(value:unknown):unknown{if(Array.isArray(value))return value.map(canonicalSemantic);if(value!==null&&typeof value==='object'){const row=value as Record<string,unknown>;return Object.fromEntries(Object.keys(row).sort().map(key=>[key,canonicalSemantic(row[key])]));}return value;}
export function remoteBridgeRequestV2Digest(request:RemoteBridgeRequestV2):string{return createHash('sha256').update(JSON.stringify(canonicalSemantic(request))).digest('hex');}
