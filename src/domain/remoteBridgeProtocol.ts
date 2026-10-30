import {createHash} from 'node:crypto';

export type RemoteBridgeTool='probe'|'git'|'npm'|'node'|'opencode'|'verify';
export interface RemoteBridgePayload {tool:RemoteBridgeTool;cwd:string;args:string[];timeout_ms:number;max_bytes:number;}
export interface RemoteBridgeRequest {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1';requestId:string;createdAt:string;expiresAt:string;appId:string;jobId:string;operation:'RUN';payload:RemoteBridgePayload;}
export interface RemoteBridgeIssueInput {title:string;body:string;authorLogin:string;expectedAuthorLogin:string;now?:Date;allowExpired?:boolean;}

const REQUEST_PREFIX='[COCWIN BRIDGE REQUEST] ';
const REQUEST_ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const APP_RE=/^[a-z][a-z0-9_-]{0,31}$/;
const JOB_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOLS=new Set<RemoteBridgeTool>(['probe','git','npm','node','opencode','verify']);
const TOP_FIELDS=new Set(['schema','requestId','createdAt','expiresAt','appId','jobId','operation','payload']);
const PAYLOAD_FIELDS=new Set(['tool','cwd','args','timeout_ms','max_bytes']);
const MAX_BODY_BYTES=65_536, MAX_TTL_MS=30*60*1000;

function fail(code:string):never{throw new Error(code);}
function record(value:unknown,code:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;}
function exactFields(row:Record<string,unknown>,fields:Set<string>,code:string):void{const keys=Object.keys(row);if(keys.length!==fields.size||keys.some(key=>!fields.has(key)))fail(code);}
function integer(value:unknown,min:number,max:number,code:string):number{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)fail(code);return Number(value);}
function iso(value:unknown,code:string):{raw:string;ms:number}{if(typeof value!=='string')fail(code);const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail(code);return {raw:value,ms};}
function cwd(value:unknown):string{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.length>1024||/\s|\0/.test(value))fail('REMOTE_BRIDGE_CWD_INVALID');const parts=value.split('/').slice(1);if(parts.some(part=>!part||part==='.'||part==='..'))fail('REMOTE_BRIDGE_CWD_INVALID');return value;}
function args(value:unknown,tool:RemoteBridgeTool):string[]{if(!Array.isArray(value)||value.length>256)fail('REMOTE_BRIDGE_ARGS_INVALID');let total=0;for(let i=0;i<value.length;i++){const arg=value[i];if(typeof arg!=='string'||arg.includes('\0'))fail('REMOTE_BRIDGE_ARGS_INVALID');const bytes=Buffer.byteLength(arg);const limit=tool==='opencode'&&i===value.length-1?24*1024:8192;if(bytes>limit)fail('REMOTE_BRIDGE_ARGS_INVALID');total+=bytes;}if(total>32768)fail('REMOTE_BRIDGE_ARGS_INVALID');return [...value] as string[];}

export function parseRemoteBridgeRequest(input:RemoteBridgeIssueInput):RemoteBridgeRequest{
  if(typeof input.expectedAuthorLogin!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(input.expectedAuthorLogin))fail('REMOTE_BRIDGE_AUTHOR_CONFIG_INVALID');
  if(input.authorLogin!==input.expectedAuthorLogin)fail('REMOTE_BRIDGE_AUTHOR_INVALID');
  if(typeof input.title!=='string'||!input.title.startsWith(REQUEST_PREFIX))fail('REMOTE_BRIDGE_TITLE_INVALID');
  if(typeof input.body!=='string'||Buffer.byteLength(input.body)>MAX_BODY_BYTES)fail('REMOTE_BRIDGE_BODY_TOO_LARGE');
  let parsed:unknown;try{parsed=JSON.parse(input.body);}catch{fail('REMOTE_BRIDGE_BODY_JSON_INVALID');}
  const row=record(parsed,'REMOTE_BRIDGE_BODY_INVALID');exactFields(row,TOP_FIELDS,'REMOTE_BRIDGE_FIELDS_INVALID');
  if(row.schema!=='COCWIN_REMOTE_BRIDGE_REQUEST_V1')fail('REMOTE_BRIDGE_SCHEMA_INVALID');
  if(typeof row.requestId!=='string'||!REQUEST_ID_RE.test(row.requestId))fail('REMOTE_BRIDGE_REQUEST_ID_INVALID');
  if(input.title!==REQUEST_PREFIX+row.requestId)fail('REMOTE_BRIDGE_TITLE_REQUEST_ID_MISMATCH');
  if(typeof row.appId!=='string'||!APP_RE.test(row.appId))fail('REMOTE_BRIDGE_APP_ID_INVALID');
  if(typeof row.jobId!=='string'||!JOB_RE.test(row.jobId))fail('REMOTE_BRIDGE_JOB_ID_INVALID');
  if(row.operation!=='RUN')fail('REMOTE_BRIDGE_OPERATION_INVALID');
  const created=iso(row.createdAt,'REMOTE_BRIDGE_CREATED_AT_INVALID'),expires=iso(row.expiresAt,'REMOTE_BRIDGE_EXPIRES_AT_INVALID');
  if(expires.ms<=created.ms)fail('REMOTE_BRIDGE_TIME_ORDER_INVALID');
  if(expires.ms-created.ms>MAX_TTL_MS)fail('REMOTE_BRIDGE_TTL_INVALID');
  const now=input.now??new Date();if(!Number.isFinite(now.getTime()))fail('REMOTE_BRIDGE_NOW_INVALID');if(!input.allowExpired&&expires.ms<=now.getTime())fail('REMOTE_BRIDGE_REQUEST_EXPIRED');
  const rawPayload=record(row.payload,'REMOTE_BRIDGE_PAYLOAD_INVALID');exactFields(rawPayload,PAYLOAD_FIELDS,'REMOTE_BRIDGE_PAYLOAD_FIELDS_INVALID');
  if(typeof rawPayload.tool!=='string'||!TOOLS.has(rawPayload.tool as RemoteBridgeTool))fail('REMOTE_BRIDGE_TOOL_INVALID');
  const tool=rawPayload.tool as RemoteBridgeTool;
  const payload:RemoteBridgePayload={tool,cwd:cwd(rawPayload.cwd),args:args(rawPayload.args,tool),timeout_ms:integer(rawPayload.timeout_ms,1000,1_800_000,'REMOTE_BRIDGE_TIMEOUT_INVALID'),max_bytes:integer(rawPayload.max_bytes,4096,1_048_576,'REMOTE_BRIDGE_MAX_BYTES_INVALID')};
  return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId:row.requestId,createdAt:created.raw,expiresAt:expires.raw,appId:row.appId,jobId:row.jobId,operation:'RUN',payload};
}

export function remoteBridgeRequestDigest(request:RemoteBridgeRequest):string{
  const canonical=JSON.stringify({schema:request.schema,requestId:request.requestId,createdAt:request.createdAt,expiresAt:request.expiresAt,appId:request.appId,jobId:request.jobId,operation:request.operation,payload:{tool:request.payload.tool,cwd:request.payload.cwd,args:request.payload.args,timeout_ms:request.payload.timeout_ms,max_bytes:request.payload.max_bytes}});
  return createHash('sha256').update(canonical).digest('hex');
}