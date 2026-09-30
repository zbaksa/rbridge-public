import type {BrowserTargetObservationV1,SendPurpose} from './rbridgeChatCore.js';

export type RbridgeChatCommandActionV1=
  |'DISCOVER_TARGET'
  |'READ_STATE'
  |'BIND_TARGET'
  |'ACQUIRE_WRITE_LEADER'
  |'ACTIVATE_CAPTURE'
  |'STAGE_PROMPT'
  |'PERSIST_SEND_INTENT'
  |'EXECUTE_PERSISTED_SEND'
  |'MARK_DELIVERY_VERIFIED'
  |'WAIT_RESPONSE';

export interface RbridgeChatCommandV1{
  schema:'RBRIDGE_CHAT_COMMAND_V1';
  commandId:string;
  action:RbridgeChatCommandActionV1;
  sessionId:string;
  generation:string;
  attemptId:string|null;
  effectId:string|null;
  requestDigest:string;
  issuedAt:string;
  payload:Record<string,unknown>;
}

export interface RbridgeChatCommandResultV1{
  schema:'RBRIDGE_CHAT_COMMAND_RESULT_V1';
  commandId:string;
  action:RbridgeChatCommandActionV1;
  sessionId:string;
  generation:string;
  attemptId:string|null;
  effectId:string|null;
  requestDigest:string;
  completedAt:string;
  ok:boolean;
  result:unknown|null;
  errorCode:string|null;
}

export interface BindTargetPayloadV1{
  windowId:number;
  tabId:number;
  origin:string;
  projectId:string;
  conversationId:string;
  conversationGeneration:number;
}

export interface DiscoverTargetPayloadV1{
  canonicalProjectId:string;
  conversationId:string;
}

export interface StagePromptPayloadV1{
  challenge:string;
  purpose:SendPurpose;
  text:string;
}

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SESSION=/^exta-[0-9a-f]{32}$/u;
const GENERATION=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ATTEMPT=/^exta-[0-9a-f]{32}:a:[1-9][0-9]*$/u;
const SHA256=/^[0-9a-f]{64}$/u;
const REASON=/^[A-Z][A-Z0-9_:-]{0,127}$/u;
const encoder=new TextEncoder();
const ACTIONS=new Set<RbridgeChatCommandActionV1>([
  'DISCOVER_TARGET','READ_STATE','BIND_TARGET','ACQUIRE_WRITE_LEADER','ACTIVATE_CAPTURE','STAGE_PROMPT',
  'PERSIST_SEND_INTENT','EXECUTE_PERSISTED_SEND','MARK_DELIVERY_VERIFIED','WAIT_RESPONSE',
]);

function fail(code:string):never{throw new Error(code);}
function obj(value:unknown,code:string):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail(code);
  return value as Record<string,unknown>;
}
function exact(row:Record<string,unknown>,keys:readonly string[],code:string):void{
  const set=new Set(keys),actual=Object.keys(row);
  if(actual.length!==set.size||actual.some(key=>!set.has(key)))fail(code);
}
function id(value:unknown,code:string):string{if(typeof value!=='string'||!ID.test(value))fail(code);return value;}
function session(value:unknown):string{if(typeof value!=='string'||!SESSION.test(value))fail('RBRIDGE_COMMAND_SESSION_INVALID');return value;}
function generation(value:unknown):string{if(typeof value!=='string'||!GENERATION.test(value))fail('RBRIDGE_COMMAND_GENERATION_INVALID');return value;}
function attempt(value:unknown,sessionId:string):string|null{
  if(value===null)return null;
  if(typeof value!=='string'||!ATTEMPT.test(value)||!value.startsWith(sessionId+':a:'))fail('RBRIDGE_COMMAND_ATTEMPT_INVALID');
  return value;
}
function effect(value:unknown):string|null{
  if(value===null)return null;
  if(typeof value!=='string'||!SHA256.test(value))fail('RBRIDGE_COMMAND_EFFECT_INVALID');
  return value;
}
function digest(value:unknown):string{if(typeof value!=='string'||!SHA256.test(value))fail('RBRIDGE_COMMAND_DIGEST_INVALID');return value;}
function iso(value:unknown,code:string):string{
  if(typeof value!=='string')fail(code);
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail(code);
  return value;
}
function integer(value:unknown,min:number,max:number,code:string):number{
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;
}
function text(value:unknown,max:number,code:string):string{
  if(typeof value!=='string'||value.includes('\0')||encoder.encode(value).byteLength>max)fail(code);return value;
}
function noPayload(payload:Record<string,unknown>):Record<string,unknown>{
  if(Object.keys(payload).length!==0)fail('RBRIDGE_COMMAND_PAYLOAD_INVALID');return {};
}

export function parseRbridgeChatCommandV1(input:unknown):RbridgeChatCommandV1{
  const row=obj(input,'RBRIDGE_COMMAND_INVALID');
  exact(row,['schema','commandId','action','sessionId','generation','attemptId','effectId','requestDigest','issuedAt','payload'],'RBRIDGE_COMMAND_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_COMMAND_V1'||typeof row.action!=='string'||!ACTIONS.has(row.action as RbridgeChatCommandActionV1))fail('RBRIDGE_COMMAND_INVALID');
  const sessionId=session(row.sessionId),attemptId=attempt(row.attemptId,sessionId),effectId=effect(row.effectId);
  const action=row.action as RbridgeChatCommandActionV1,payload=obj(row.payload,'RBRIDGE_COMMAND_PAYLOAD_INVALID');
  if((action==='STAGE_PROMPT'||action==='PERSIST_SEND_INTENT'||action==='EXECUTE_PERSISTED_SEND'||action==='MARK_DELIVERY_VERIFIED'||action==='WAIT_RESPONSE')&&(!attemptId||!effectId))fail('RBRIDGE_COMMAND_CORRELATION_REQUIRED');
  if((action==='DISCOVER_TARGET'||action==='READ_STATE'||action==='BIND_TARGET'||action==='ACQUIRE_WRITE_LEADER'||action==='ACTIVATE_CAPTURE')&&(attemptId!==null||effectId!==null))fail('RBRIDGE_COMMAND_CORRELATION_UNEXPECTED');
  validatePayload(action,payload);
  const value:RbridgeChatCommandV1={
    schema:'RBRIDGE_CHAT_COMMAND_V1',commandId:id(row.commandId,'RBRIDGE_COMMAND_ID_INVALID'),action,sessionId,generation:generation(row.generation),
    attemptId,effectId,requestDigest:digest(row.requestDigest),issuedAt:iso(row.issuedAt,'RBRIDGE_COMMAND_TIME_INVALID'),payload,
  };
  if(encoder.encode(JSON.stringify(value)).byteLength>65536)fail('RBRIDGE_COMMAND_TOO_LARGE');
  return value;
}

function validatePayload(action:RbridgeChatCommandActionV1,payload:Record<string,unknown>):void{
  if(action==='DISCOVER_TARGET'){
    exact(payload,['canonicalProjectId','conversationId'],'RBRIDGE_COMMAND_PAYLOAD_INVALID');
    id(payload.canonicalProjectId,'RBRIDGE_CANONICAL_PROJECT_INVALID');id(payload.conversationId,'RBRIDGE_CONVERSATION_ID_INVALID');return;
  }
  if(action==='BIND_TARGET'){
    exact(payload,['windowId','tabId','origin','projectId','conversationId','conversationGeneration'],'RBRIDGE_COMMAND_PAYLOAD_INVALID');
    integer(payload.windowId,0,2147483647,'RBRIDGE_WINDOW_ID_INVALID');integer(payload.tabId,0,2147483647,'RBRIDGE_TAB_ID_INVALID');
    const origin=text(payload.origin,512,'RBRIDGE_ORIGIN_INVALID');try{if(new URL(origin).origin!==origin)fail('RBRIDGE_ORIGIN_INVALID');}catch{fail('RBRIDGE_ORIGIN_INVALID');}
    id(payload.projectId,'RBRIDGE_PROJECT_ID_INVALID');id(payload.conversationId,'RBRIDGE_CONVERSATION_ID_INVALID');
    integer(payload.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID');return;
  }
  if(action==='STAGE_PROMPT'){
    exact(payload,['challenge','purpose','text'],'RBRIDGE_COMMAND_PAYLOAD_INVALID');
    if(typeof payload.challenge!=='string'||!SHA256.test(payload.challenge))fail('RBRIDGE_COMMAND_CHALLENGE_INVALID');
    if(payload.purpose!=='PROMPT'&&payload.purpose!=='RESULT')fail('RBRIDGE_COMMAND_PURPOSE_INVALID');
    text(payload.text,48000,'RBRIDGE_COMMAND_PROMPT_TOO_LARGE');return;
  }
  noPayload(payload);
}

export function commandBindTarget(command:RbridgeChatCommandV1,browserInstanceId:string,browserProfileId:string):BrowserTargetObservationV1{
  if(command.action!=='BIND_TARGET')fail('RBRIDGE_COMMAND_ACTION_INVALID');
  const p=command.payload as unknown as BindTargetPayloadV1;
  return {
    sessionId:command.sessionId,generation:command.generation,browserInstanceId,browserProfileId,
    windowId:p.windowId,tabId:p.tabId,origin:p.origin,projectId:p.projectId,conversationId:p.conversationId,
    conversationGeneration:p.conversationGeneration,ownerSessionId:command.sessionId,
  };
}

export function commandErrorCode(error:unknown):string{
  const value=error instanceof Error?error.message:String(error);
  return REASON.test(value)?value:'RBRIDGE_COMMAND_FAILED';
}

export function buildCommandResultV1(command:RbridgeChatCommandV1,input:{ok:true;result:unknown}|{ok:false;errorCode:string},now=new Date()):RbridgeChatCommandResultV1{
  const base={
    schema:'RBRIDGE_CHAT_COMMAND_RESULT_V1' as const,commandId:command.commandId,action:command.action,sessionId:command.sessionId,generation:command.generation,
    attemptId:command.attemptId,effectId:command.effectId,requestDigest:command.requestDigest,completedAt:now.toISOString(),
  };
  const result:RbridgeChatCommandResultV1=input.ok?{...base,ok:true,result:input.result,errorCode:null}:{...base,ok:false,result:null,errorCode:commandErrorCode(input.errorCode)};
  if(encoder.encode(JSON.stringify(result)).byteLength>65536)fail('RBRIDGE_COMMAND_RESULT_TOO_LARGE');
  return result;
}

export function parseRbridgeChatCommandResultV1(input:unknown):RbridgeChatCommandResultV1{
  const row=obj(input,'RBRIDGE_COMMAND_RESULT_INVALID');
  exact(row,['schema','commandId','action','sessionId','generation','attemptId','effectId','requestDigest','completedAt','ok','result','errorCode'],'RBRIDGE_COMMAND_RESULT_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_COMMAND_RESULT_V1'||typeof row.action!=='string'||!ACTIONS.has(row.action as RbridgeChatCommandActionV1)||typeof row.ok!=='boolean')fail('RBRIDGE_COMMAND_RESULT_INVALID');
  const sessionId=session(row.sessionId),attemptId=attempt(row.attemptId,sessionId),effectId=effect(row.effectId);
  if(row.ok===true&&row.errorCode!==null)fail('RBRIDGE_COMMAND_RESULT_INVALID');
  if(row.ok===false&&(row.result!==null||typeof row.errorCode!=='string'||!REASON.test(row.errorCode)))fail('RBRIDGE_COMMAND_RESULT_INVALID');
  const value:RbridgeChatCommandResultV1={
    schema:'RBRIDGE_CHAT_COMMAND_RESULT_V1',commandId:id(row.commandId,'RBRIDGE_COMMAND_ID_INVALID'),action:row.action as RbridgeChatCommandActionV1,
    sessionId,generation:generation(row.generation),attemptId,effectId,requestDigest:digest(row.requestDigest),
    completedAt:iso(row.completedAt,'RBRIDGE_COMMAND_TIME_INVALID'),ok:row.ok,result:row.result,errorCode:row.errorCode as string|null,
  };
  if(encoder.encode(JSON.stringify(value)).byteLength>65536)fail('RBRIDGE_COMMAND_RESULT_TOO_LARGE');
  return value;
}
