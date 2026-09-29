export const M0_LIMITS = Object.freeze({
  maxPromptUtf8Bytes: 48_000,
  maxRbridgeControlMessageUtf8Bytes: 65_536,
  maxAssistantTurnUtf8Bytes: 16_384,
  maxMachineBlockUtf8Bytes: 16_384,
});

export const REQUIRED_RBRIDGE_CAPABILITIES = Object.freeze([
  'CHAT_TARGET_DISCOVERY_V1',
  'CHAT_BINDING_V1',
  'CHAT_WRITE_LEADER_V1',
  'CHAT_CAPTURE_V1',
  'CHAT_SEND_TX_V1',
  'CHAT_QUOTA_OBSERVATION_V1',
  'CHAT_ROLLOVER_V1',
  'REPLAY_SEQUENCE_V1',
] as const);

const SESSION_RE=/^exta-[0-9a-f]{32}$/;
const GENERATION_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTEMPT_RE=/^exta-[0-9a-f]{32}:a:[1-9][0-9]*$/;
const SHA256_RE=/^[0-9a-f]{64}$/;
const SHA1_RE=/^[0-9a-f]{40}$/;
const REASON_RE=/^[A-Z][A-Z0-9_:-]{0,127}$/;
const CAPABILITY_RE=/^[A-Z][A-Z0-9_]{0,63}$/;
const encoder=new TextEncoder();

export type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
export type SendPurpose='PROMPT'|'RESULT';
export type SendTxState=
  |'PREPARING'|'READY_NOT_SENT'|'SEND_INTENT'|'CLICKED_UNVERIFIED'
  |'SENT_VERIFIED'|'WAITING_RESPONSE'|'RESPONSE_VERIFIED'
  |'FAILED_BEFORE_CLICK'|'UNCERTAIN'|'SUPERSEDED'|'STOPPED';

export interface CocwinReceiptRefV1{
  schema:'COCWIN_RECEIPT_REF_V1';receiptId:string;receiptSchema:string;sha256:string;
}

export interface RbridgeChatHelloV1{
  schema:'RBRIDGE_CHAT_HELLO_V1';
  protocolMajor:1;
  protocolMinor:number;
  releaseSha:string;
  maxMessageBytes:number;
  capabilities:string[];
  browserInstanceId:string;
  browserProfileId:string;
  nativeHostVersion:string;
}

export interface NegotiatedHelloV1{
  schema:'RBRIDGE_CHAT_NEGOTIATED_HELLO_V1';
  protocolMajor:1;
  protocolMinor:number;
  maxMessageBytes:number;
  capabilities:string[];
  localReleaseSha:string;
  peerReleaseSha:string;
}

export interface BrowserTargetObservationV1{
  sessionId:string;
  generation:string;
  browserInstanceId:string;
  browserProfileId:string;
  windowId:number;
  tabId:number;
  origin:string;
  projectId:string;
  conversationId:string;
  conversationGeneration:number;
  ownerSessionId:string;
}

export interface BrowserBindingControlV1 extends BrowserTargetObservationV1{
  schema:'RBRIDGE_CHAT_BINDING_CONTROL_V1';
  status:'PREPARED'|'VERIFIED'|'STALE';
  writeLeaderEpoch:number;
  captureEpoch:number;
  preparedAt:string;
  verifiedAt:string|null;
  staleReason:string|null;
}

export interface RbridgeChatBindingReceiptV1{
  schema:'RBRIDGE_CHAT_BINDING_RECEIPT_V1';
  receiptId:string;
  sessionId:string;
  generation:string;
  browserInstanceId:string;
  browserProfileId:string;
  windowId:number;
  tabId:number;
  origin:string;
  projectId:string;
  conversationId:string;
  conversationGeneration:number;
  ownerSessionId:string;
  writeLeaderEpoch:number;
  captureEpoch:number;
  observedAt:string;
  sha256:string;
}

export interface WriteLeaderControlV1{
  schema:'RBRIDGE_CHAT_WRITE_LEADER_CONTROL_V1';
  status:'NOT_ACQUIRED'|'ACTIVE'|'RELEASED'|'STALE';
  sessionId:string;
  generation:string;
  conversationId:string;
  conversationGeneration:number;
  ownerSessionId:string;
  epoch:number;
  acquiredAt:string|null;
  releasedAt:string|null;
  reason:string|null;
}

export interface CaptureControlV1{
  schema:'RBRIDGE_CHAT_CAPTURE_CONTROL_V1';
  status:'OFF'|'ACTIVE'|'LOST';
  sessionId:string;
  generation:string;
  conversationId:string;
  conversationGeneration:number;
  writeLeaderEpoch:number;
  epoch:number;
  activatedAt:string|null;
  lostAt:string|null;
  reason:string|null;
}

export interface RbridgeSendTransactionV1{
  schema:'RBRIDGE_CHAT_SEND_TRANSACTION_V1';
  state:SendTxState;
  sessionId:string;
  generation:string;
  attemptId:string;
  effectId:string;
  challenge:string;
  purpose:SendPurpose;
  conversationId:string;
  conversationGeneration:number;
  writeLeaderEpoch:number;
  captureEpoch:number;
  payloadUtf8Bytes:number;
  createdAt:string;
  intentAt:string|null;
  clickedAt:string|null;
  sentVerifiedAt:string|null;
  responseVerifiedAt:string|null;
  reason:string|null;
}

export interface RbridgeChatSendReceiptV1{
  schema:'RBRIDGE_CHAT_SEND_RECEIPT_V1';
  receiptId:string;
  sessionId:string;
  generation:string;
  attemptId:string;
  effectId:string;
  challenge:string;
  purpose:SendPurpose;
  transactionState:'FAILED_BEFORE_CLICK'|'UNCERTAIN'|'SENT_VERIFIED'|'STOPPED'|'SUPERSEDED';
  conversationId:string;
  conversationGeneration:number;
  writeLeaderEpoch:number;
  observedAt:string;
  sha256:string;
}

export interface RbridgeChatCaptureReceiptV1{
  schema:'RBRIDGE_CHAT_CAPTURE_RECEIPT_V1';
  receiptId:string;
  sessionId:string;
  generation:string;
  attemptId:string;
  effectId:string;
  challenge:string;
  conversationId:string;
  conversationGeneration:number;
  assistantTurnId:string;
  responseUtf8Bytes:number;
  machineBlockSha256:string|null;
  captureEpoch:number;
  observedAt:string;
  sha256:string;
}

export interface RbridgeChatEventV1{
  schema:'RBRIDGE_CHAT_EVENT_V1';
  eventId:string;
  sequence:number;
  previousEventSha256:string|null;
  eventType:string;
  sessionId:string;
  generation:string;
  attemptId:string|null;
  effectId:string|null;
  observedAt:string;
  payload:Record<string,JsonValue>;
  eventSha256:string;
}

function fail(code:string):never{throw new Error(code);}
function ownObject(value:unknown,code:string):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail(code);
  return value as Record<string,unknown>;
}
function exactKeys(row:Record<string,unknown>,keys:readonly string[],code:string):void{
  const expected=new Set(keys),actual=Object.keys(row);
  if(actual.length!==expected.size||actual.some(key=>!expected.has(key)))fail(code);
}
function safeString(value:unknown,maxBytes:number,code:string):string{
  if(typeof value!=='string'||value.length===0||value.includes('\0')||encoder.encode(value).byteLength>maxBytes)fail(code);
  return value;
}
function integer(value:unknown,min:number,max:number,code:string):number{
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);
  return value;
}
function assertSession(value:unknown):string{if(typeof value!=='string'||!SESSION_RE.test(value))fail('RBRIDGE_SESSION_ID_INVALID');return value;}
function assertGeneration(value:unknown):string{if(typeof value!=='string'||!GENERATION_RE.test(value))fail('RBRIDGE_GENERATION_INVALID');return value;}
function assertAttempt(value:unknown,sessionId:string):string{if(typeof value!=='string'||!ATTEMPT_RE.test(value)||!value.startsWith(sessionId+':a:'))fail('RBRIDGE_ATTEMPT_ID_INVALID');return value;}
function assertEffect(value:unknown):string{if(typeof value!=='string'||!SHA256_RE.test(value))fail('RBRIDGE_EFFECT_ID_INVALID');return value;}
function assertChallenge(value:unknown):string{if(typeof value!=='string'||!SHA256_RE.test(value))fail('RBRIDGE_CHALLENGE_INVALID');return value;}
function assertIso(value:unknown,code='RBRIDGE_TIMESTAMP_INVALID'):string{
  if(typeof value!=='string')fail(code);const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail(code);return value;
}
function assertReason(value:unknown):string{if(typeof value!=='string'||!REASON_RE.test(value))fail('RBRIDGE_REASON_INVALID');return value;}
function assertIdentity(value:unknown,maxBytes:number,code:string):string{
  const out=safeString(value,maxBytes,code);if(/[\u0000-\u001f\u007f]/u.test(out))fail(code);return out;
}
function canonicalOrigin(value:unknown):string{
  const raw=safeString(value,512,'RBRIDGE_ORIGIN_INVALID');let url:URL;try{url=new URL(raw);}catch{fail('RBRIDGE_ORIGIN_INVALID');}
  if((url.protocol!=='https:'&&url.protocol!=='http:')||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==raw)fail('RBRIDGE_ORIGIN_INVALID');
  return raw;
}
function nowIso(now:Date):string{if(!(now instanceof Date)||!Number.isFinite(now.getTime()))fail('RBRIDGE_NOW_INVALID');return now.toISOString();}

function receiptPayload(value:unknown):Record<string,JsonValue>{
  const row=ownObject(value,'RBRIDGE_RECEIPT_REF_INVALID');
  exactKeys(row,['schema','receiptId','receiptSchema','sha256'],'RBRIDGE_RECEIPT_REF_FIELDS_INVALID');
  if(row.schema!=='COCWIN_RECEIPT_REF_V1')fail('RBRIDGE_RECEIPT_REF_INVALID');
  const receiptId=assertIdentity(row.receiptId,512,'RBRIDGE_RECEIPT_ID_INVALID');
  const receiptSchema=assertIdentity(row.receiptSchema,128,'RBRIDGE_RECEIPT_SCHEMA_INVALID');
  if(typeof row.sha256!=='string'||!SHA256_RE.test(row.sha256))fail('RBRIDGE_RECEIPT_SHA_INVALID');
  return {schema:'COCWIN_RECEIPT_REF_V1',receiptId,receiptSchema,sha256:row.sha256};
}

function eventPurpose(value:unknown):'PROMPT'|'RESULT'{
  if(value!=='PROMPT'&&value!=='RESULT')fail('RBRIDGE_EVENT_PURPOSE_INVALID');
  return value;
}

function validateFrozenEventPayload(eventType:string,value:unknown):Record<string,JsonValue>{
  const row=ownObject(value,'RBRIDGE_EVENT_PAYLOAD_INVALID');
  const receiptOnly=()=>{
    exactKeys(row,['receipt'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
    return {receipt:receiptPayload(row.receipt)};
  };
  const reasonOnly=()=>{
    exactKeys(row,['reason'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
    return {reason:assertReason(row.reason)};
  };
  switch(eventType){
    case 'BINDING_VERIFIED':
    case 'WRITE_LEADER_ACQUIRED':
    case 'CAPTURE_ACTIVE':
      return receiptOnly();
    case 'BINDING_LOST':
    case 'WRITE_LEADER_RELEASED':
    case 'CAPTURE_LOST':
      return reasonOnly();
    case 'SEND_INTENT_PERSISTED':
    case 'SEND_VERIFIED':{
      exactKeys(row,['purpose','receipt'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
      return {purpose:eventPurpose(row.purpose),receipt:receiptPayload(row.receipt)};
    }
    case 'SEND_UNCERTAIN':{
      exactKeys(row,['purpose','reason','receipt'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
      return {purpose:eventPurpose(row.purpose),reason:assertReason(row.reason),receipt:receiptPayload(row.receipt)};
    }
    case 'RESPONSE_CAPTURED':{
      exactKeys(row,['captureReceipt','machineBlockUtf8'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
      let machineBlockUtf8:null|string=null;
      if(row.machineBlockUtf8!==null){
        if(typeof row.machineBlockUtf8!=='string'||encoder.encode(row.machineBlockUtf8).byteLength>M0_LIMITS.maxMachineBlockUtf8Bytes)fail('MACHINE_RESPONSE_TOO_LARGE');
        machineBlockUtf8=row.machineBlockUtf8;
      }
      return {captureReceipt:receiptPayload(row.captureReceipt),machineBlockUtf8};
    }
    case 'QUOTA_OBSERVED':{
      exactKeys(row,['capability','state','resetAt','receipt'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
      if(row.capability!=='BROWSER_WORK'&&row.capability!=='BROWSER_CHAT_FAST'&&row.capability!=='BROWSER_CHAT_STRONG')fail('RBRIDGE_QUOTA_CAPABILITY_INVALID');
      if(row.state!=='AVAILABLE'&&row.state!=='QUOTA_EXHAUSTED'&&row.state!=='RATE_LIMITED'&&row.state!=='AUTH_REQUIRED'&&
        row.state!=='MODEL_UNAVAILABLE'&&row.state!=='SURFACE_UNAVAILABLE'&&row.state!=='UI_PROTOCOL_CHANGED'&&
        row.state!=='NETWORK_UNAVAILABLE'&&row.state!=='PROBE_REQUIRED'&&row.state!=='UNKNOWN')fail('RBRIDGE_QUOTA_STATE_INVALID');
      const resetAt=row.resetAt===null?null:assertIso(row.resetAt,'RBRIDGE_QUOTA_RESET_AT_INVALID');
      return {capability:row.capability,state:row.state,resetAt,receipt:receiptPayload(row.receipt)};
    }
    case 'ROLLOVER_VERIFIED':{
      exactKeys(row,['previousConversationId','newConversationId','bindingReceipt'],'RBRIDGE_EVENT_PAYLOAD_FIELDS_INVALID');
      return {
        previousConversationId:assertIdentity(row.previousConversationId,256,'RBRIDGE_ROLLOVER_PREVIOUS_INVALID'),
        newConversationId:assertIdentity(row.newConversationId,256,'RBRIDGE_ROLLOVER_NEW_INVALID'),
        bindingReceipt:receiptPayload(row.bindingReceipt),
      };
    }
    default:
      fail('RBRIDGE_EVENT_TYPE_INVALID');
  }
}

export function canonicalJson(value:unknown):string{
  const visit=(item:unknown):JsonValue=>{
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'){if(!Number.isSafeInteger(item))fail('RBRIDGE_CANONICAL_JSON_NUMBER_INVALID');return item;}
    if(Array.isArray(item))return item.map(visit);
    if(typeof item==='object'){
      const row=item as Record<string,unknown>,out:Record<string,JsonValue>={};
      const keys=Object.keys(row).sort((a,b)=>a<b?-1:a>b?1:0);
      for(const key of keys){if(!/^[\x20-\x7e]+$/u.test(key))fail('RBRIDGE_CANONICAL_JSON_KEY_INVALID');out[key]=visit(row[key]);}
      return out;
    }
    fail('RBRIDGE_CANONICAL_JSON_VALUE_INVALID');
  };
  return JSON.stringify(visit(value));
}

export async function sha256Hex(value:string|Uint8Array):Promise<string>{
  const source=typeof value==='string'?encoder.encode(value):value;
  const bytes=new Uint8Array(source.byteLength);bytes.set(source);
  const digest=await crypto.subtle.digest('SHA-256',bytes.buffer);
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function canonicalDigest(value:unknown):Promise<string>{return await sha256Hex(canonicalJson(value));}

export function parseHello(input:unknown):RbridgeChatHelloV1{
  const row=ownObject(input,'RBRIDGE_HELLO_INVALID');
  exactKeys(row,['schema','protocolMajor','protocolMinor','releaseSha','maxMessageBytes','capabilities','browserInstanceId','browserProfileId','nativeHostVersion'],'RBRIDGE_HELLO_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_HELLO_V1')fail('RBRIDGE_HELLO_SCHEMA_INVALID');
  if(row.protocolMajor!==1)fail('PROTOCOL_MAJOR_MISMATCH');
  const protocolMinor=integer(row.protocolMinor,0,65535,'RBRIDGE_PROTOCOL_MINOR_INVALID');
  if(typeof row.releaseSha!=='string'||!SHA1_RE.test(row.releaseSha))fail('RBRIDGE_RELEASE_SHA_INVALID');
  const maxMessageBytes=integer(row.maxMessageBytes,1024,M0_LIMITS.maxRbridgeControlMessageUtf8Bytes,'RBRIDGE_MESSAGE_LIMIT_INVALID');
  if(!Array.isArray(row.capabilities)||row.capabilities.length<1||row.capabilities.length>64)fail('RBRIDGE_CAPABILITIES_INVALID');
  const capabilities=row.capabilities.map(value=>{if(typeof value!=='string'||!CAPABILITY_RE.test(value))fail('RBRIDGE_CAPABILITIES_INVALID');return value;});
  if(new Set(capabilities).size!==capabilities.length)fail('RBRIDGE_CAPABILITIES_INVALID');
  return {
    schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor,releaseSha:row.releaseSha,maxMessageBytes,capabilities,
    browserInstanceId:assertIdentity(row.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),
    browserProfileId:assertIdentity(row.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
    nativeHostVersion:assertIdentity(row.nativeHostVersion,64,'RBRIDGE_NATIVE_HOST_VERSION_INVALID'),
  };
}

export function negotiateHello(localInput:unknown,peerInput:unknown):NegotiatedHelloV1{
  const local=parseHello(localInput),peer=parseHello(peerInput);
  const localCaps=new Set(local.capabilities),peerCaps=new Set(peer.capabilities);
  for(const capability of REQUIRED_RBRIDGE_CAPABILITIES)if(!localCaps.has(capability)||!peerCaps.has(capability))fail('RBRIDGE_CAPABILITY_MISSING');
  return {
    schema:'RBRIDGE_CHAT_NEGOTIATED_HELLO_V1',protocolMajor:1,protocolMinor:Math.min(local.protocolMinor,peer.protocolMinor),
    maxMessageBytes:Math.min(local.maxMessageBytes,peer.maxMessageBytes,M0_LIMITS.maxRbridgeControlMessageUtf8Bytes),
    capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],localReleaseSha:local.releaseSha,peerReleaseSha:peer.releaseSha,
  };
}

export function validateTarget(input:BrowserTargetObservationV1):BrowserTargetObservationV1{
  const sessionId=assertSession(input.sessionId),generation=assertGeneration(input.generation),ownerSessionId=assertSession(input.ownerSessionId);
  if(ownerSessionId!==sessionId)fail('RBRIDGE_BINDING_OWNER_MISMATCH');
  return {
    sessionId,generation,
    browserInstanceId:assertIdentity(input.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),
    browserProfileId:assertIdentity(input.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
    windowId:integer(input.windowId,0,2_147_483_647,'RBRIDGE_WINDOW_ID_INVALID'),
    tabId:integer(input.tabId,0,2_147_483_647,'RBRIDGE_TAB_ID_INVALID'),
    origin:canonicalOrigin(input.origin),
    projectId:assertIdentity(input.projectId,256,'RBRIDGE_PROJECT_ID_INVALID'),
    conversationId:assertIdentity(input.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
    conversationGeneration:integer(input.conversationGeneration,1,2_147_483_647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
    ownerSessionId,
  };
}

export function prepareBinding(targetInput:BrowserTargetObservationV1,now=new Date()):BrowserBindingControlV1{
  const target=validateTarget(targetInput),preparedAt=nowIso(now);
  return {schema:'RBRIDGE_CHAT_BINDING_CONTROL_V1',status:'PREPARED',...target,writeLeaderEpoch:0,captureEpoch:0,preparedAt,verifiedAt:null,staleReason:null};
}

function sameTarget(control:BrowserBindingControlV1,targetInput:BrowserTargetObservationV1):boolean{
  const target=validateTarget(targetInput);
  return control.sessionId===target.sessionId&&control.generation===target.generation&&control.browserInstanceId===target.browserInstanceId&&
    control.browserProfileId===target.browserProfileId&&control.windowId===target.windowId&&control.tabId===target.tabId&&control.origin===target.origin&&
    control.projectId===target.projectId&&control.conversationId===target.conversationId&&control.conversationGeneration===target.conversationGeneration&&
    control.ownerSessionId===target.ownerSessionId;
}

export async function verifyBinding(control:BrowserBindingControlV1,observed:BrowserTargetObservationV1,now=new Date()):Promise<{control:BrowserBindingControlV1;receipt:RbridgeChatBindingReceiptV1}>{
  if(control.status!=='PREPARED'&&control.status!=='VERIFIED')fail('RBRIDGE_BINDING_VERIFY_STATE_INVALID');
  if(!sameTarget(control,observed))fail('BROWSER_BINDING_STALE');
  const verifiedAt=nowIso(now),next:BrowserBindingControlV1={...control,status:'VERIFIED',verifiedAt,staleReason:null};
  const withoutSha=Object.freeze({
    schema:'RBRIDGE_CHAT_BINDING_RECEIPT_V1' as const,
    receiptId:'rbridge-binding:'+next.sessionId+':'+next.conversationId+':'+String(next.conversationGeneration),
    sessionId:next.sessionId,generation:next.generation,browserInstanceId:next.browserInstanceId,browserProfileId:next.browserProfileId,
    windowId:next.windowId,tabId:next.tabId,origin:next.origin,projectId:next.projectId,conversationId:next.conversationId,
    conversationGeneration:next.conversationGeneration,ownerSessionId:next.ownerSessionId,writeLeaderEpoch:next.writeLeaderEpoch,captureEpoch:next.captureEpoch,observedAt:verifiedAt,
  });
  return {control:next,receipt:{...withoutSha,sha256:await canonicalDigest(withoutSha)}};
}

export function invalidateBinding(control:BrowserBindingControlV1,reason:string):BrowserBindingControlV1{
  return {...control,status:'STALE',staleReason:assertReason(reason),verifiedAt:null};
}

export function acquireWriteLeader(binding:BrowserBindingControlV1,previous:WriteLeaderControlV1|null=null,now=new Date()):WriteLeaderControlV1{
  if(binding.status!=='VERIFIED')fail('BROWSER_BINDING_STALE');
  if(binding.ownerSessionId!==binding.sessionId)fail('RBRIDGE_BINDING_OWNER_MISMATCH');
  const floor=Math.max(binding.writeLeaderEpoch,previous?.epoch??0),epoch=floor+1;
  return {schema:'RBRIDGE_CHAT_WRITE_LEADER_CONTROL_V1',status:'ACTIVE',sessionId:binding.sessionId,generation:binding.generation,
    conversationId:binding.conversationId,conversationGeneration:binding.conversationGeneration,ownerSessionId:binding.ownerSessionId,epoch,
    acquiredAt:nowIso(now),releasedAt:null,reason:null};
}

export function releaseWriteLeader(leader:WriteLeaderControlV1,reason:string,now=new Date()):WriteLeaderControlV1{
  if(leader.status!=='ACTIVE')return leader;
  return {...leader,status:'RELEASED',releasedAt:nowIso(now),reason:assertReason(reason)};
}

function assertLiveAuthority(binding:BrowserBindingControlV1,leader:WriteLeaderControlV1):void{
  if(binding.status!=='VERIFIED'||leader.status!=='ACTIVE')fail('BROWSER_BINDING_STALE');
  if(binding.sessionId!==leader.sessionId||binding.generation!==leader.generation||binding.conversationId!==leader.conversationId||
    binding.conversationGeneration!==leader.conversationGeneration||binding.ownerSessionId!==leader.ownerSessionId)fail('BROWSER_BINDING_STALE');
}

export function activateCapture(binding:BrowserBindingControlV1,leader:WriteLeaderControlV1,previous:CaptureControlV1|null=null,now=new Date()):CaptureControlV1{
  assertLiveAuthority(binding,leader);
  const epoch=Math.max(binding.captureEpoch,previous?.epoch??0)+1;
  return {schema:'RBRIDGE_CHAT_CAPTURE_CONTROL_V1',status:'ACTIVE',sessionId:binding.sessionId,generation:binding.generation,
    conversationId:binding.conversationId,conversationGeneration:binding.conversationGeneration,writeLeaderEpoch:leader.epoch,epoch,
    activatedAt:nowIso(now),lostAt:null,reason:null};
}

export function loseCapture(capture:CaptureControlV1,reason:string,now=new Date()):CaptureControlV1{
  if(capture.status!=='ACTIVE')return capture;
  return {...capture,status:'LOST',lostAt:nowIso(now),reason:assertReason(reason)};
}

function assertCaptureAuthority(binding:BrowserBindingControlV1,leader:WriteLeaderControlV1,capture:CaptureControlV1):void{
  assertLiveAuthority(binding,leader);
  if(capture.status!=='ACTIVE'||capture.sessionId!==binding.sessionId||capture.generation!==binding.generation||
    capture.conversationId!==binding.conversationId||capture.conversationGeneration!==binding.conversationGeneration||capture.writeLeaderEpoch!==leader.epoch)fail('BROWSER_BINDING_STALE');
}

export function createSendTransaction(input:{sessionId:string;generation:string;attemptId:string;effectId:string;challenge:string;purpose:SendPurpose;payloadUtf8Bytes:number},binding:BrowserBindingControlV1,leader:WriteLeaderControlV1,capture:CaptureControlV1,now=new Date()):RbridgeSendTransactionV1{
  assertCaptureAuthority(binding,leader,capture);
  const sessionId=assertSession(input.sessionId),generation=assertGeneration(input.generation),attemptId=assertAttempt(input.attemptId,sessionId);
  if(sessionId!==binding.sessionId||generation!==binding.generation)fail('BROWSER_BINDING_STALE');
  const payloadUtf8Bytes=integer(input.payloadUtf8Bytes,0,M0_LIMITS.maxPromptUtf8Bytes,'RBRIDGE_SEND_PAYLOAD_TOO_LARGE');
  if(input.purpose!=='PROMPT'&&input.purpose!=='RESULT')fail('RBRIDGE_SEND_PURPOSE_INVALID');
  return {schema:'RBRIDGE_CHAT_SEND_TRANSACTION_V1',state:'PREPARING',sessionId,generation,attemptId,effectId:assertEffect(input.effectId),
    challenge:assertChallenge(input.challenge),purpose:input.purpose,conversationId:binding.conversationId,conversationGeneration:binding.conversationGeneration,
    writeLeaderEpoch:leader.epoch,captureEpoch:capture.epoch,payloadUtf8Bytes,createdAt:nowIso(now),intentAt:null,clickedAt:null,sentVerifiedAt:null,responseVerifiedAt:null,reason:null};
}

function transition(tx:RbridgeSendTransactionV1,allowed:readonly SendTxState[],next:SendTxState,patch:Partial<RbridgeSendTransactionV1>={}):RbridgeSendTransactionV1{
  if(!allowed.includes(tx.state))fail('RBRIDGE_SEND_STATE_INVALID');return {...tx,...patch,state:next};
}
export function markSendReady(tx:RbridgeSendTransactionV1):RbridgeSendTransactionV1{return transition(tx,['PREPARING'],'READY_NOT_SENT');}
export function persistSendIntent(tx:RbridgeSendTransactionV1,now=new Date()):RbridgeSendTransactionV1{return transition(tx,['READY_NOT_SENT'],'SEND_INTENT',{intentAt:nowIso(now)});}
export function markClicked(tx:RbridgeSendTransactionV1,now=new Date()):RbridgeSendTransactionV1{return transition(tx,['SEND_INTENT'],'CLICKED_UNVERIFIED',{clickedAt:nowIso(now)});}
export function markSentVerified(tx:RbridgeSendTransactionV1,now=new Date()):RbridgeSendTransactionV1{return transition(tx,['CLICKED_UNVERIFIED','UNCERTAIN'],'SENT_VERIFIED',{sentVerifiedAt:nowIso(now),reason:null});}
export function markWaitingResponse(tx:RbridgeSendTransactionV1):RbridgeSendTransactionV1{return transition(tx,['SENT_VERIFIED'],'WAITING_RESPONSE');}
export function markResponseVerified(tx:RbridgeSendTransactionV1,now=new Date()):RbridgeSendTransactionV1{return transition(tx,['WAITING_RESPONSE','SENT_VERIFIED','UNCERTAIN'],'RESPONSE_VERIFIED',{responseVerifiedAt:nowIso(now),reason:null});}
export function markFailedBeforeClick(tx:RbridgeSendTransactionV1,reason:string):RbridgeSendTransactionV1{return transition(tx,['PREPARING','READY_NOT_SENT'],'FAILED_BEFORE_CLICK',{reason:assertReason(reason)});}
export function markSendUncertain(tx:RbridgeSendTransactionV1,reason='SEND_UNCERTAIN'):RbridgeSendTransactionV1{return transition(tx,['SEND_INTENT','CLICKED_UNVERIFIED','SENT_VERIFIED','WAITING_RESPONSE'],'UNCERTAIN',{reason:assertReason(reason)});}
export function stopSend(tx:RbridgeSendTransactionV1,reason:string):RbridgeSendTransactionV1{
  if(tx.state==='SEND_INTENT'||tx.state==='CLICKED_UNVERIFIED'||tx.state==='UNCERTAIN')fail('SEND_UNCERTAIN');
  if(tx.state==='SENT_VERIFIED'||tx.state==='WAITING_RESPONSE')fail('RBRIDGE_SEND_RESPONSE_PENDING');
  return transition(tx,['PREPARING','READY_NOT_SENT'],'STOPPED',{reason:assertReason(reason)});
}
export function supersedeSend(tx:RbridgeSendTransactionV1,reason:string):RbridgeSendTransactionV1{
  if(tx.state==='SEND_INTENT'||tx.state==='CLICKED_UNVERIFIED'||tx.state==='UNCERTAIN')fail('SEND_UNCERTAIN');
  if(tx.state==='SENT_VERIFIED'||tx.state==='WAITING_RESPONSE')fail('RBRIDGE_SEND_RESPONSE_PENDING');
  return transition(tx,['PREPARING','READY_NOT_SENT'],'SUPERSEDED',{reason:assertReason(reason)});
}

function sendProjectionState(state:SendTxState):RbridgeChatSendReceiptV1['transactionState']{
  if(state==='FAILED_BEFORE_CLICK'||state==='UNCERTAIN'||state==='STOPPED'||state==='SUPERSEDED')return state;
  if(state==='SENT_VERIFIED'||state==='WAITING_RESPONSE'||state==='RESPONSE_VERIFIED')return 'SENT_VERIFIED';
  fail('RBRIDGE_SEND_RECEIPT_NOT_READY');
}

export async function projectSendReceipt(tx:RbridgeSendTransactionV1,now=new Date()):Promise<RbridgeChatSendReceiptV1>{
  const observedAt=nowIso(now),transactionState=sendProjectionState(tx.state);
  const withoutSha={schema:'RBRIDGE_CHAT_SEND_RECEIPT_V1' as const,receiptId:'rbridge-send:'+tx.effectId,sessionId:tx.sessionId,generation:tx.generation,
    attemptId:tx.attemptId,effectId:tx.effectId,challenge:tx.challenge,purpose:tx.purpose,transactionState,conversationId:tx.conversationId,
    conversationGeneration:tx.conversationGeneration,writeLeaderEpoch:tx.writeLeaderEpoch,observedAt};
  return {...withoutSha,sha256:await canonicalDigest(withoutSha)};
}

export async function captureResponse(input:{assistantTurnId:string;responseText:string;machineBlockUtf8:string|null},tx:RbridgeSendTransactionV1,capture:CaptureControlV1,now=new Date()):Promise<{receipt:RbridgeChatCaptureReceiptV1;machineBlockUtf8:string|null}>{
  if(tx.state!=='SENT_VERIFIED'&&tx.state!=='WAITING_RESPONSE'&&tx.state!=='UNCERTAIN'&&tx.state!=='RESPONSE_VERIFIED')fail('RBRIDGE_CAPTURE_SEND_STATE_INVALID');
  if(capture.status!=='ACTIVE'||capture.epoch!==tx.captureEpoch||capture.writeLeaderEpoch!==tx.writeLeaderEpoch||capture.sessionId!==tx.sessionId||capture.generation!==tx.generation||
    capture.conversationId!==tx.conversationId||capture.conversationGeneration!==tx.conversationGeneration)fail('BROWSER_BINDING_STALE');
  const assistantTurnId=assertIdentity(input.assistantTurnId,256,'RBRIDGE_ASSISTANT_TURN_ID_INVALID');
  const responseText=typeof input.responseText==='string'?input.responseText:fail('RBRIDGE_RESPONSE_INVALID');
  const responseUtf8Bytes=encoder.encode(responseText).byteLength;if(responseUtf8Bytes>M0_LIMITS.maxAssistantTurnUtf8Bytes)fail('OUTPUT_BUDGET_EXCEEDED');
  let machineBlockSha256:string|null=null;
  if(input.machineBlockUtf8!==null){
    if(typeof input.machineBlockUtf8!=='string'||encoder.encode(input.machineBlockUtf8).byteLength>M0_LIMITS.maxMachineBlockUtf8Bytes)fail('MACHINE_RESPONSE_TOO_LARGE');
    machineBlockSha256=await sha256Hex(input.machineBlockUtf8);
  }
  const observedAt=nowIso(now),withoutSha={schema:'RBRIDGE_CHAT_CAPTURE_RECEIPT_V1' as const,receiptId:'rbridge-capture:'+tx.effectId+':'+assistantTurnId,
    sessionId:tx.sessionId,generation:tx.generation,attemptId:tx.attemptId,effectId:tx.effectId,challenge:tx.challenge,conversationId:tx.conversationId,
    conversationGeneration:tx.conversationGeneration,assistantTurnId,responseUtf8Bytes,machineBlockSha256,captureEpoch:capture.epoch,observedAt};
  return {receipt:{...withoutSha,sha256:await canonicalDigest(withoutSha)},machineBlockUtf8:input.machineBlockUtf8};
}

function cloneEventValue(value:RbridgeChatEventV1):RbridgeChatEventV1{return structuredClone(value);}

export class RbridgeEventSpoolV1{
  private readonly events:RbridgeChatEventV1[]=[];
  private readonly byId=new Map<string,RbridgeChatEventV1>();
  get size():number{return this.events.length;}
  list():readonly RbridgeChatEventV1[]{return this.events.map(cloneEventValue);}
  async append(input:{eventId:string;eventType:string;sessionId:string;generation:string;attemptId:string|null;effectId:string|null;observedAt:string;payload:Record<string,JsonValue>}):Promise<RbridgeChatEventV1>{
    const eventId=assertIdentity(input.eventId,192,'RBRIDGE_EVENT_ID_INVALID'),sessionId=assertSession(input.sessionId),generation=assertGeneration(input.generation);
    const attemptId=input.attemptId===null?null:assertAttempt(input.attemptId,sessionId),effectId=input.effectId===null?null:assertEffect(input.effectId),observedAt=assertIso(input.observedAt);
    const eventType=assertIdentity(input.eventType,128,'RBRIDGE_EVENT_TYPE_INVALID');
    const payload=validateFrozenEventPayload(eventType,input.payload);
    const existing=this.byId.get(eventId);
    if(existing){
      const replayWithoutSha={schema:'RBRIDGE_CHAT_EVENT_V1' as const,eventId,sequence:existing.sequence,previousEventSha256:existing.previousEventSha256,eventType,sessionId,generation,attemptId,effectId,observedAt,payload};
      if(await canonicalDigest(replayWithoutSha)!==existing.eventSha256)fail('REQUEST_ID_COLLISION');
      return cloneEventValue(existing);
    }
    const sequence=this.events.length+1,previousEventSha256=this.events.at(-1)?.eventSha256??null;
    const withoutSha={schema:'RBRIDGE_CHAT_EVENT_V1' as const,eventId,sequence,previousEventSha256,eventType,sessionId,generation,attemptId,effectId,observedAt,payload};
    const eventSha256=await canonicalDigest(withoutSha),candidate:RbridgeChatEventV1={...withoutSha,eventSha256};
    this.events.push(candidate);this.byId.set(eventId,candidate);return cloneEventValue(candidate);
  }
}

export async function validateEventEnvelope(input:unknown,expectedPreviousSha:string|null=null,expectedSequence:number|null=null):Promise<RbridgeChatEventV1>{
  const row=ownObject(input,'RBRIDGE_EVENT_INVALID');
  exactKeys(row,['schema','eventId','sequence','previousEventSha256','eventType','sessionId','generation','attemptId','effectId','observedAt','payload','eventSha256'],'RBRIDGE_EVENT_FIELDS_INVALID');
  if(row.schema!=='RBRIDGE_CHAT_EVENT_V1')fail('RBRIDGE_EVENT_SCHEMA_INVALID');
  const sessionId=assertSession(row.sessionId),sequence=integer(row.sequence,1,Number.MAX_SAFE_INTEGER,'RBRIDGE_EVENT_SEQUENCE_INVALID');
  const previous=row.previousEventSha256;if(previous!==null&&(typeof previous!=='string'||!SHA256_RE.test(previous)))fail('RBRIDGE_EVENT_PREVIOUS_DIGEST_INVALID');
  if(expectedSequence!==null&&sequence!==expectedSequence)fail('RBRIDGE_EVENT_SEQUENCE_GAP');
  if(expectedPreviousSha!==null&&previous!==expectedPreviousSha)fail('RBRIDGE_EVENT_CHAIN_MISMATCH');
  const eventType=assertIdentity(row.eventType,128,'RBRIDGE_EVENT_TYPE_INVALID');
  const payload=validateFrozenEventPayload(eventType,row.payload);
  const candidate={schema:'RBRIDGE_CHAT_EVENT_V1' as const,eventId:assertIdentity(row.eventId,192,'RBRIDGE_EVENT_ID_INVALID'),sequence,previousEventSha256:previous as string|null,
    eventType,sessionId,generation:assertGeneration(row.generation),
    attemptId:row.attemptId===null?null:assertAttempt(row.attemptId,sessionId),effectId:row.effectId===null?null:assertEffect(row.effectId),observedAt:assertIso(row.observedAt),payload};
  if(typeof row.eventSha256!=='string'||!SHA256_RE.test(row.eventSha256))fail('RBRIDGE_EVENT_DIGEST_INVALID');
  if(await canonicalDigest(candidate)!==row.eventSha256)fail('RBRIDGE_EVENT_DIGEST_INVALID');
  return {...candidate,eventSha256:row.eventSha256};
}
