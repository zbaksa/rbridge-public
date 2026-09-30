import {
  canonicalDigest,canonicalJson,
  type BrowserBindingControlV1,type CaptureControlV1,type RbridgeSendTransactionV1,type SendTxState,type WriteLeaderControlV1,
} from '../domain/rbridgeChatCore.js';

export interface BrowserAuthoritySnapshotV1{
  schema:'RBRIDGE_BROWSER_AUTHORITY_SNAPSHOT_V1';
  revision:number;
  binding:BrowserBindingControlV1|null;
  leader:WriteLeaderControlV1|null;
  capture:CaptureControlV1|null;
  activeSend:RbridgeSendTransactionV1|null;
  updatedAt:string;
  sha256:string;
}

export interface BrowserAuthorityStateV1{
  binding:BrowserBindingControlV1|null;
  leader:WriteLeaderControlV1|null;
  capture:CaptureControlV1|null;
  activeSend:RbridgeSendTransactionV1|null;
}

export interface ChromeStorageAreaV1{
  get(key:string):Promise<Record<string,unknown>>;
  set(items:Record<string,unknown>):Promise<void>;
}

const KEY='rbridgeBrowserAuthorityV1';
const SESSION=/^exta-[0-9a-f]{32}$/;
const GENERATION=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTEMPT=/^exta-[0-9a-f]{32}:a:[1-9][0-9]*$/;
const SHA256=/^[0-9a-f]{64}$/;
const REASON=/^[A-Z][A-Z0-9_:-]{0,127}$/;
const SEND_STATES=new Set<SendTxState>([
  'PREPARING','READY_NOT_SENT','SEND_INTENT','CLICKED_UNVERIFIED','SENT_VERIFIED','WAITING_RESPONSE','RESPONSE_VERIFIED',
  'FAILED_BEFORE_CLICK','UNCERTAIN','SUPERSEDED','STOPPED',
]);
const encoder=new TextEncoder();
function fail(code:string):never{throw new Error(code);}
function obj(value:unknown,code:string):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;
}
function exact(row:Record<string,unknown>,keys:readonly string[],code:string):void{
  const set=new Set(keys),actual=Object.keys(row);if(actual.length!==set.size||actual.some(key=>!set.has(key)))fail(code);
}
function text(value:unknown,max:number,code:string):string{
  if(typeof value!=='string'||value.length===0||value.includes('\0')||encoder.encode(value).byteLength>max)fail(code);return value;
}
function integer(value:unknown,min:number,max:number,code:string):number{
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;
}
function session(value:unknown):string{if(typeof value!=='string'||!SESSION.test(value))fail('RBRIDGE_AUTHORITY_SESSION_INVALID');return value;}
function generation(value:unknown):string{if(typeof value!=='string'||!GENERATION.test(value))fail('RBRIDGE_AUTHORITY_GENERATION_INVALID');return value;}
function iso(value:unknown,nullable=false):string|null{
  if(nullable&&value===null)return null;
  if(typeof value!=='string')fail('RBRIDGE_AUTHORITY_TIME_INVALID');
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail('RBRIDGE_AUTHORITY_TIME_INVALID');return value;
}
function reason(value:unknown):string|null{
  if(value===null)return null;if(typeof value!=='string'||!REASON.test(value))fail('RBRIDGE_AUTHORITY_REASON_INVALID');return value;
}
function clone<T>(value:T):T{return structuredClone(value);}

function binding(value:unknown):BrowserBindingControlV1{
  const row=obj(value,'RBRIDGE_AUTHORITY_BINDING_INVALID');
  exact(row,['schema','status','sessionId','generation','browserInstanceId','browserProfileId','windowId','tabId','origin','projectId','conversationId','conversationGeneration','ownerSessionId','writeLeaderEpoch','captureEpoch','preparedAt','verifiedAt','staleReason'],'RBRIDGE_AUTHORITY_BINDING_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_BINDING_CONTROL_V1'||(row.status!=='PREPARED'&&row.status!=='VERIFIED'&&row.status!=='STALE'))fail('RBRIDGE_AUTHORITY_BINDING_STATE_INVALID');
  const sessionId=session(row.sessionId),ownerSessionId=session(row.ownerSessionId);if(sessionId!==ownerSessionId)fail('RBRIDGE_BINDING_OWNER_MISMATCH');
  let origin:string;
  try{const url=new URL(text(row.origin,512,'RBRIDGE_ORIGIN_INVALID'));if(url.origin!==row.origin||url.pathname!=='/'||url.search||url.hash)fail('RBRIDGE_ORIGIN_INVALID');origin=url.origin;}catch(error){if(error instanceof Error&&error.message.startsWith('RBRIDGE_'))throw error;fail('RBRIDGE_ORIGIN_INVALID');}
  const verifiedAt=iso(row.verifiedAt,true),staleReason=reason(row.staleReason);
  if(row.status==='VERIFIED'&&verifiedAt===null)fail('RBRIDGE_AUTHORITY_BINDING_VERIFICATION_INVALID');
  if(row.status==='STALE'&&staleReason===null)fail('RBRIDGE_AUTHORITY_BINDING_STALE_REASON_REQUIRED');
  return {
    schema:'RBRIDGE_CHAT_BINDING_CONTROL_V1',status:row.status,sessionId,generation:generation(row.generation),
    browserInstanceId:text(row.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),browserProfileId:text(row.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
    windowId:integer(row.windowId,0,2147483647,'RBRIDGE_WINDOW_ID_INVALID'),tabId:integer(row.tabId,0,2147483647,'RBRIDGE_TAB_ID_INVALID'),origin,
    projectId:text(row.projectId,256,'RBRIDGE_PROJECT_ID_INVALID'),conversationId:text(row.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
    conversationGeneration:integer(row.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),ownerSessionId,
    writeLeaderEpoch:integer(row.writeLeaderEpoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),captureEpoch:integer(row.captureEpoch,0,2147483647,'RBRIDGE_CAPTURE_EPOCH_INVALID'),
    preparedAt:iso(row.preparedAt)! as string,verifiedAt,staleReason,
  };
}

function leader(value:unknown):WriteLeaderControlV1{
  const row=obj(value,'RBRIDGE_AUTHORITY_LEADER_INVALID');
  exact(row,['schema','status','sessionId','generation','conversationId','conversationGeneration','ownerSessionId','epoch','acquiredAt','releasedAt','reason'],'RBRIDGE_AUTHORITY_LEADER_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_WRITE_LEADER_CONTROL_V1'||(row.status!=='NOT_ACQUIRED'&&row.status!=='ACTIVE'&&row.status!=='RELEASED'&&row.status!=='STALE'))fail('RBRIDGE_AUTHORITY_LEADER_STATE_INVALID');
  const sessionId=session(row.sessionId),ownerSessionId=session(row.ownerSessionId);if(sessionId!==ownerSessionId)fail('RBRIDGE_BINDING_OWNER_MISMATCH');
  const acquiredAt=iso(row.acquiredAt,true),releasedAt=iso(row.releasedAt,true),why=reason(row.reason);
  if(row.status==='ACTIVE'&&acquiredAt===null)fail('RBRIDGE_AUTHORITY_LEADER_ACQUIRED_AT_REQUIRED');
  return {schema:'RBRIDGE_CHAT_WRITE_LEADER_CONTROL_V1',status:row.status,sessionId,generation:generation(row.generation),
    conversationId:text(row.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),conversationGeneration:integer(row.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
    ownerSessionId,epoch:integer(row.epoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),acquiredAt,releasedAt,reason:why};
}

function capture(value:unknown):CaptureControlV1{
  const row=obj(value,'RBRIDGE_AUTHORITY_CAPTURE_INVALID');
  exact(row,['schema','status','sessionId','generation','conversationId','conversationGeneration','writeLeaderEpoch','epoch','activatedAt','lostAt','reason'],'RBRIDGE_AUTHORITY_CAPTURE_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_CAPTURE_CONTROL_V1'||(row.status!=='OFF'&&row.status!=='ACTIVE'&&row.status!=='LOST'))fail('RBRIDGE_AUTHORITY_CAPTURE_STATE_INVALID');
  const activatedAt=iso(row.activatedAt,true),lostAt=iso(row.lostAt,true),why=reason(row.reason);
  if(row.status==='ACTIVE'&&activatedAt===null)fail('RBRIDGE_AUTHORITY_CAPTURE_ACTIVATED_AT_REQUIRED');
  return {schema:'RBRIDGE_CHAT_CAPTURE_CONTROL_V1',status:row.status,sessionId:session(row.sessionId),generation:generation(row.generation),
    conversationId:text(row.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),conversationGeneration:integer(row.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
    writeLeaderEpoch:integer(row.writeLeaderEpoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),epoch:integer(row.epoch,0,2147483647,'RBRIDGE_CAPTURE_EPOCH_INVALID'),
    activatedAt,lostAt,reason:why};
}

function send(value:unknown):RbridgeSendTransactionV1{
  const row=obj(value,'RBRIDGE_AUTHORITY_SEND_INVALID');
  exact(row,['schema','state','sessionId','generation','attemptId','effectId','challenge','purpose','conversationId','conversationGeneration','writeLeaderEpoch','captureEpoch','payloadUtf8Bytes','createdAt','intentAt','clickedAt','sentVerifiedAt','responseVerifiedAt','reason'],'RBRIDGE_AUTHORITY_SEND_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_SEND_TRANSACTION_V1'||typeof row.state!=='string'||!SEND_STATES.has(row.state as SendTxState))fail('RBRIDGE_AUTHORITY_SEND_STATE_INVALID');
  const sessionId=session(row.sessionId);
  if(typeof row.attemptId!=='string'||!ATTEMPT.test(row.attemptId)||!row.attemptId.startsWith(sessionId+':a:'))fail('RBRIDGE_ATTEMPT_ID_INVALID');
  if(typeof row.effectId!=='string'||!SHA256.test(row.effectId)||typeof row.challenge!=='string'||!SHA256.test(row.challenge))fail('RBRIDGE_AUTHORITY_SEND_CORRELATION_INVALID');
  if(row.purpose!=='PROMPT'&&row.purpose!=='RESULT')fail('RBRIDGE_SEND_PURPOSE_INVALID');
  const intentAt=iso(row.intentAt,true),clickedAt=iso(row.clickedAt,true),sentVerifiedAt=iso(row.sentVerifiedAt,true),responseVerifiedAt=iso(row.responseVerifiedAt,true);
  if((row.state==='SEND_INTENT'||row.state==='CLICKED_UNVERIFIED'||row.state==='SENT_VERIFIED'||row.state==='WAITING_RESPONSE'||row.state==='RESPONSE_VERIFIED'||row.state==='UNCERTAIN')&&intentAt===null)fail('RBRIDGE_AUTHORITY_SEND_INTENT_MISSING');
  if((row.state==='CLICKED_UNVERIFIED'||row.state==='SENT_VERIFIED'||row.state==='WAITING_RESPONSE'||row.state==='RESPONSE_VERIFIED')&&clickedAt===null)fail('RBRIDGE_AUTHORITY_SEND_CLICK_MISSING');
  return {schema:'RBRIDGE_CHAT_SEND_TRANSACTION_V1',state:row.state as SendTxState,sessionId,generation:generation(row.generation),attemptId:row.attemptId,
    effectId:row.effectId,challenge:row.challenge,purpose:row.purpose,conversationId:text(row.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
    conversationGeneration:integer(row.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),writeLeaderEpoch:integer(row.writeLeaderEpoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),
    captureEpoch:integer(row.captureEpoch,0,2147483647,'RBRIDGE_CAPTURE_EPOCH_INVALID'),payloadUtf8Bytes:integer(row.payloadUtf8Bytes,0,48000,'RBRIDGE_SEND_PAYLOAD_TOO_LARGE'),
    createdAt:iso(row.createdAt)! as string,intentAt,clickedAt,sentVerifiedAt,responseVerifiedAt,reason:reason(row.reason)};
}

function validateCross(state:BrowserAuthorityStateV1):void{
  const {binding:b,leader:l,capture:c,activeSend:s}=state;
  if(l&&(!b||l.sessionId!==b.sessionId||l.generation!==b.generation||l.conversationId!==b.conversationId||l.conversationGeneration!==b.conversationGeneration))fail('RBRIDGE_AUTHORITY_LEADER_BINDING_MISMATCH');
  if(l?.status==='ACTIVE'&&b?.status!=='VERIFIED')fail('BROWSER_BINDING_STALE');
  if(c&&(!b||!l||c.sessionId!==b.sessionId||c.generation!==b.generation||c.conversationId!==b.conversationId||c.conversationGeneration!==b.conversationGeneration||c.writeLeaderEpoch!==l.epoch))fail('RBRIDGE_AUTHORITY_CAPTURE_BINDING_MISMATCH');
  if(c?.status==='ACTIVE'&&l?.status!=='ACTIVE')fail('RBRIDGE_AUTHORITY_CAPTURE_LEADER_INACTIVE');
  if(s&&(!b||!l||!c||s.sessionId!==b.sessionId||s.generation!==b.generation||s.conversationId!==b.conversationId||s.conversationGeneration!==b.conversationGeneration||s.writeLeaderEpoch!==l.epoch||s.captureEpoch!==c.epoch))fail('RBRIDGE_AUTHORITY_SEND_BINDING_MISMATCH');
}

export async function validateBrowserAuthoritySnapshotV1(input:unknown):Promise<BrowserAuthoritySnapshotV1>{
  const row=obj(input,'RBRIDGE_AUTHORITY_SNAPSHOT_INVALID');
  exact(row,['schema','revision','binding','leader','capture','activeSend','updatedAt','sha256'],'RBRIDGE_AUTHORITY_SNAPSHOT_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_BROWSER_AUTHORITY_SNAPSHOT_V1'||typeof row.sha256!=='string'||!SHA256.test(row.sha256))fail('RBRIDGE_AUTHORITY_SNAPSHOT_INVALID');
  const state:BrowserAuthorityStateV1={
    binding:row.binding===null?null:binding(row.binding),leader:row.leader===null?null:leader(row.leader),
    capture:row.capture===null?null:capture(row.capture),activeSend:row.activeSend===null?null:send(row.activeSend),
  };
  validateCross(state);
  const revision=integer(row.revision,1,Number.MAX_SAFE_INTEGER,'RBRIDGE_AUTHORITY_REVISION_INVALID'),updatedAt=iso(row.updatedAt)! as string;
  const body={schema:'RBRIDGE_BROWSER_AUTHORITY_SNAPSHOT_V1' as const,revision,...state,updatedAt};
  if(await canonicalDigest(body)!==row.sha256)fail('RBRIDGE_AUTHORITY_DIGEST_INVALID');
  if(encoder.encode(canonicalJson({...body,sha256:row.sha256})).byteLength>65536)fail('RBRIDGE_AUTHORITY_SNAPSHOT_TOO_LARGE');
  return {...body,sha256:row.sha256};
}

export class BrowserAuthorityStoreV1{
  private queue:Promise<void>=Promise.resolve();
  constructor(private readonly storage:ChromeStorageAreaV1){}

  async load():Promise<BrowserAuthoritySnapshotV1|null>{
    await this.queue;
    const row=await this.storage.get(KEY),value=row[KEY];
    return value===undefined?null:await validateBrowserAuthoritySnapshotV1(value);
  }

  async commit(expectedRevision:number,state:BrowserAuthorityStateV1,now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    let release!:()=>void;const prior=this.queue;this.queue=new Promise<void>(resolve=>{release=resolve;});await prior;
    try{
      if(!Number.isInteger(expectedRevision)||expectedRevision<0)fail('RBRIDGE_AUTHORITY_REVISION_INVALID');
      const row=await this.storage.get(KEY),current=row[KEY]===undefined?null:await validateBrowserAuthoritySnapshotV1(row[KEY]);
      const actual=current?.revision??0;if(actual!==expectedRevision)fail('RBRIDGE_AUTHORITY_REVISION_MISMATCH');
      const clean:BrowserAuthorityStateV1={
        binding:state.binding===null?null:binding(state.binding),leader:state.leader===null?null:leader(state.leader),
        capture:state.capture===null?null:capture(state.capture),activeSend:state.activeSend===null?null:send(state.activeSend),
      };
      validateCross(clean);
      const updatedAt=now.toISOString();if(new Date(updatedAt).getTime()!==now.getTime())fail('RBRIDGE_AUTHORITY_TIME_INVALID');
      const body={schema:'RBRIDGE_BROWSER_AUTHORITY_SNAPSHOT_V1' as const,revision:actual+1,...clean,updatedAt};
      const snapshot:BrowserAuthoritySnapshotV1={...body,sha256:await canonicalDigest(body)};
      if(encoder.encode(canonicalJson(snapshot)).byteLength>65536)fail('RBRIDGE_AUTHORITY_SNAPSHOT_TOO_LARGE');
      try{await this.storage.set({[KEY]:clone(snapshot)});}
      catch{throw new Error('RBRIDGE_AUTHORITY_STORE_WRITE_UNCERTAIN');}
      return clone(snapshot);
    }finally{release();}
  }
}
