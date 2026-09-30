import type {CocwinReceiptRefV1,RbridgeSendTransactionV1} from './rbridgeChatCore.js';

export type BrowserQuotaCapability='BROWSER_WORK'|'BROWSER_CHAT_FAST'|'BROWSER_CHAT_STRONG';
export type BrowserQuotaState=
  |'AVAILABLE'|'QUOTA_EXHAUSTED'|'RATE_LIMITED'|'AUTH_REQUIRED'|'MODEL_UNAVAILABLE'
  |'SURFACE_UNAVAILABLE'|'UI_PROTOCOL_CHANGED'|'NETWORK_UNAVAILABLE'|'PROBE_REQUIRED'|'UNKNOWN';

export interface BrowserQuotaObservationV1{
  capability:BrowserQuotaCapability;
  state:BrowserQuotaState;
  resetAt:string|null;
  receipt:CocwinReceiptRefV1;
}

export interface RolloverCheckpointV1{
  durableSessionState:boolean;
  streamedResponseActive:boolean;
  currentSend:RbridgeSendTransactionV1|null;
}

export interface RolloverProofV1{
  previousConversationId:string;
  newConversationId:string;
  bindingReceipt:CocwinReceiptRefV1;
}

const QUOTA_CAPABILITIES=new Set<BrowserQuotaCapability>(['BROWSER_WORK','BROWSER_CHAT_FAST','BROWSER_CHAT_STRONG']);
const QUOTA_STATES=new Set<BrowserQuotaState>([
  'AVAILABLE','QUOTA_EXHAUSTED','RATE_LIMITED','AUTH_REQUIRED','MODEL_UNAVAILABLE','SURFACE_UNAVAILABLE',
  'UI_PROTOCOL_CHANGED','NETWORK_UNAVAILABLE','PROBE_REQUIRED','UNKNOWN',
]);
const SHA256=/^[0-9a-f]{64}$/;
const REASONABLE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function fail(code:string):never{throw new Error(code);}
function isoOrNull(value:string|null):string|null{
  if(value===null)return null;
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail('RBRIDGE_QUOTA_RESET_AT_INVALID');return value;
}
function receipt(value:CocwinReceiptRefV1):CocwinReceiptRefV1{
  if(!value||value.schema!=='COCWIN_RECEIPT_REF_V1'||typeof value.receiptId!=='string'||value.receiptId.length===0||
    typeof value.receiptSchema!=='string'||value.receiptSchema.length===0||!SHA256.test(value.sha256))fail('RBRIDGE_RECEIPT_REF_INVALID');
  return {...value};
}
function conversationId(value:string,code:string):string{
  if(typeof value!=='string'||!REASONABLE_ID.test(value))fail(code);return value;
}
export function validateQuotaObservation(input:BrowserQuotaObservationV1):BrowserQuotaObservationV1{
  if(!QUOTA_CAPABILITIES.has(input.capability))fail('RBRIDGE_QUOTA_CAPABILITY_INVALID');
  if(!QUOTA_STATES.has(input.state))fail('RBRIDGE_QUOTA_STATE_INVALID');
  const resetAt=isoOrNull(input.resetAt);
  return {capability:input.capability,state:input.state,resetAt,receipt:receipt(input.receipt)};
}
export function quotaEligibleForRouting(input:BrowserQuotaObservationV1):boolean{
  return validateQuotaObservation(input).state==='AVAILABLE';
}
export function assertSafeRolloverCheckpoint(checkpoint:RolloverCheckpointV1):void{
  if(!checkpoint.durableSessionState)fail('RBRIDGE_ROLLOVER_SESSION_NOT_DURABLE');
  if(checkpoint.streamedResponseActive)fail('RBRIDGE_ROLLOVER_STREAM_ACTIVE');
  const tx=checkpoint.currentSend;if(tx===null)return;
  const safe=new Set(['RESPONSE_VERIFIED','FAILED_BEFORE_CLICK','STOPPED','SUPERSEDED']);
  if(!safe.has(tx.state))fail(tx.state==='UNCERTAIN'||tx.state==='SEND_INTENT'||tx.state==='CLICKED_UNVERIFIED'?'SEND_UNCERTAIN':'RBRIDGE_ROLLOVER_SEND_NOT_QUIESCENT');
}
export function createRolloverProof(input:RolloverProofV1,checkpoint:RolloverCheckpointV1):RolloverProofV1{
  assertSafeRolloverCheckpoint(checkpoint);
  const previousConversationId=conversationId(input.previousConversationId,'RBRIDGE_ROLLOVER_PREVIOUS_INVALID');
  const newConversationId=conversationId(input.newConversationId,'RBRIDGE_ROLLOVER_NEW_INVALID');
  if(previousConversationId===newConversationId)fail('RBRIDGE_ROLLOVER_CONVERSATION_UNCHANGED');
  return {previousConversationId,newConversationId,bindingReceipt:receipt(input.bindingReceipt)};
}
