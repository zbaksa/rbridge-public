import {canonicalDigest,canonicalJson,parseV3Scope,type V3Scope} from './rbridgeEffectProtocol.js';
import {parseRbridgeChatCommandV1,parseRbridgeChatCommandResultV1,type RbridgeChatCommandV1,type RbridgeChatCommandResultV1} from './rbridgeChatCommand.js';
import {snapshotNativeMessage} from '../nativeHost/nativeHostProtocol.js';

export type RbridgeReadQueryActionV1='READ_STATE'|'DISCOVER_TARGET';
export interface RbridgeReadQueryV1 {scope:V3Scope;command:RbridgeChatCommandV1}
export interface RbridgeReadQueryRecordV1 extends RbridgeReadQueryV1 {
  schema:'RBRIDGE_CHAT_READ_QUERY_RECORD_V1';channelId:string;submittedAt:number;expiresAt:number;
  state:'QUEUED'|'DISPATCHED'|'COMPLETE';result:RbridgeChatCommandResultV1|null;receivedAt:number|null;
}
export const RBRIDGE_READ_QUERY_TTL_MS=5000;
function fail(code='RBRIDGE_READ_QUERY_INVALID'):never{throw Error(code);}
function exact(input:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input))fail();const row=input as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))fail();return row;
}
function time(input:unknown):number{if(typeof input!=='number'||!Number.isSafeInteger(input)||input<0)fail();return input;}

/** Existing V1 read commands only. The digest supplies correlation, never peer authentication. */
export async function parseRbridgeReadQuery(input:unknown):Promise<RbridgeReadQueryV1>{
  const row=exact(snapshotNativeMessage(input,8192),['scope','command']),scope=parseV3Scope(row.scope),command=parseRbridgeChatCommandV1(row.command);
  if(command.action!=='READ_STATE'&&command.action!=='DISCOVER_TARGET')fail('RBRIDGE_READ_QUERY_ACTION_DENIED');
  if(command.sessionId!==scope.sessionId||command.generation!==scope.generation)fail('RBRIDGE_READ_QUERY_SCOPE_MISMATCH');
  const {requestDigest,...body}=command;
  if(requestDigest!==await canonicalDigest({schema:'RBRIDGE_CHAT_READ_QUERY_DIGEST_V1',scope,command:body}))fail('RBRIDGE_READ_QUERY_DIGEST_MISMATCH');
  return {scope,command};
}
export async function buildRbridgeReadQuery(scope:V3Scope,action:RbridgeReadQueryActionV1,payload:Record<string,unknown>,commandId:string,issuedAt:string):Promise<RbridgeReadQueryV1>{
  const input=snapshotNativeMessage({scope,action,payload,commandId,issuedAt},8192) as {scope:V3Scope;action:RbridgeReadQueryActionV1;payload:Record<string,unknown>;commandId:string;issuedAt:string};
  const current=parseV3Scope(input.scope),command={schema:'RBRIDGE_CHAT_COMMAND_V1' as const,commandId:input.commandId,action:input.action,sessionId:current.sessionId,generation:current.generation,attemptId:null,effectId:null,issuedAt:input.issuedAt,payload:input.payload};
  const requestDigest=await canonicalDigest({schema:'RBRIDGE_CHAT_READ_QUERY_DIGEST_V1',scope:current,command});
  return await parseRbridgeReadQuery({scope:current,command:{...command,requestDigest}});
}
export function correlateRbridgeReadQueryResult(input:unknown,command:RbridgeChatCommandV1):RbridgeChatCommandResultV1{
  const result=parseRbridgeChatCommandResultV1(input);
  for(const key of ['commandId','action','sessionId','generation','attemptId','effectId','requestDigest'] as const)if(result[key]!==command[key])fail('RBRIDGE_READ_QUERY_RESULT_MISMATCH');
  return result;
}
/** Parses original retained evidence without treating it as fresh or current-channel authority. */
export async function parseRbridgeReadQueryRecord(input:unknown):Promise<RbridgeReadQueryRecordV1>{
  const row=exact(snapshotNativeMessage(input,131072),['schema','scope','command','channelId','submittedAt','expiresAt','state','result','receivedAt']);
  if(row.schema!=='RBRIDGE_CHAT_READ_QUERY_RECORD_V1'||typeof row.channelId!=='string'||!/^[a-f0-9]{32}$/.test(row.channelId)||!['QUEUED','DISPATCHED','COMPLETE'].includes(String(row.state)))fail();
  const query=await parseRbridgeReadQuery({scope:row.scope,command:row.command}),submittedAt=time(row.submittedAt),expiresAt=time(row.expiresAt);
  if(!Number.isSafeInteger(submittedAt+RBRIDGE_READ_QUERY_TTL_MS)||expiresAt!==submittedAt+RBRIDGE_READ_QUERY_TTL_MS)fail();
  if(row.state==='COMPLETE'){
    if(row.result===null)fail();const receivedAt=time(row.receivedAt);if(receivedAt<submittedAt||receivedAt>=expiresAt)fail();
    row.result=correlateRbridgeReadQueryResult(row.result,query.command);
  }else if(row.result!==null||row.receivedAt!==null)fail();
  return {...row,...query} as unknown as RbridgeReadQueryRecordV1;
}
export function assertRbridgeReadQueryCurrent(record:RbridgeReadQueryRecordV1,scope:V3Scope,channelId:string,now=Date.now()):void{
  if(canonicalJson(record.scope)!==canonicalJson(scope))fail('RBRIDGE_READ_QUERY_SCOPE_MISMATCH');
  if(record.channelId!==channelId)fail('RBRIDGE_READ_QUERY_CHANNEL_CHANGED');
  if(!Number.isSafeInteger(now)||now<record.submittedAt||now>=record.expiresAt)fail('RBRIDGE_READ_QUERY_STALE');
}
