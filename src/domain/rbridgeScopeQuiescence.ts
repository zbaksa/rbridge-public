import {canonicalDigest,canonicalJson,parseV3Scope,type V3Scope} from './rbridgeEffectProtocol.js';

export const RBRIDGE_SCOPE_QUIESCENCE_TTL_MS=30000;
export const RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY='CHAT_SCOPE_QUIESCENCE_V1';
export interface RbridgeScopeStopRequestV1 {
  schema:'RBRIDGE_SCOPE_STOP_REQUEST_V1';requestId:string;scope:V3Scope;challenge:string;issuedAt:string;requestDigest:string;
}
export interface RbridgeScopeStopFenceV1 {
  schema:'RBRIDGE_SCOPE_STOP_FENCE_V1';state:'STOP_REQUESTED';request:RbridgeScopeStopRequestV1;recordedAt:string;sha256:string;
}
export interface RbridgeScopeQuiescenceQueryV1 {
  schema:'RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1';queryId:string;queryNonce:string;request:RbridgeScopeStopRequestV1;
  channelId:string;peerPinsSha256:string;submittedAt:number;expiresAt:number;sha256:string;
}
/** Wire facts have no host-specific provenance label or quiescence decision. */
export interface RbridgeScopeResultInventoryV1 {
  schema:'RBRIDGE_SCOPE_RESULT_INVENTORY_V1';scope:V3Scope;entryCount:number;unresolvedCount:number;entriesSha256:string;sha256:string;
}
export interface RbridgeScopeEventHeadV1 {sequence:number;eventSha256:string|null}
export interface RbridgeWorkerQuiescenceReportV1 {
  schema:'RBRIDGE_SCOPE_QUIESCENCE_WORKER_V1';querySha256:string;fence:RbridgeScopeStopFenceV1;
  sealed:boolean;captureStopped:boolean;pendingHandlers:number;pendingReaders:number;pendingEgress:number;unresolvedCaptureCount:number;
  resultInventory:RbridgeScopeResultInventoryV1;eventHead:RbridgeScopeEventHeadV1;observedAt:string;sha256:string;
}
export interface RbridgeNativeQuiescenceReportV1 {
  schema:'RBRIDGE_SCOPE_QUIESCENCE_NATIVE_V1';querySha256:string;worker:RbridgeWorkerQuiescenceReportV1;
  resultInventory:RbridgeScopeResultInventoryV1;eventHead:RbridgeScopeEventHeadV1;observedAt:string;sha256:string;
}
export interface RbridgeScopeQuiescenceRecordV1 {
  schema:'RBRIDGE_SCOPE_QUIESCENCE_RECORD_V1';query:RbridgeScopeQuiescenceQueryV1;
  state:'QUEUED'|'DISPATCHED'|'COMPLETE';nativeReport:RbridgeNativeQuiescenceReportV1|null;receivedAt:number|null;sha256:string;
}
export interface RbridgeScopeQuiescenceCurrentV1 {scope:V3Scope;channelId:string;peerPinsSha256:string;now:number}
export type ScopeStopRequestInputV1=Omit<RbridgeScopeStopRequestV1,'schema'|'requestDigest'>;
export type ScopeQuiescenceQueryInputV1=Omit<RbridgeScopeQuiescenceQueryV1,'schema'|'expiresAt'|'sha256'>;
export type ScopeResultInventoryInputV1=Omit<RbridgeScopeResultInventoryV1,'schema'|'sha256'>;
export type WorkerQuiescenceFactsV1=Omit<RbridgeWorkerQuiescenceReportV1,'schema'|'querySha256'|'sha256'>;
export type NativeQuiescenceFactsV1=Omit<RbridgeNativeQuiescenceReportV1,'schema'|'querySha256'|'sha256'>;
export type ScopeQuiescenceRecordInputV1=Omit<RbridgeScopeQuiescenceRecordV1,'schema'|'sha256'>;

type Row=Record<string,unknown>;
const REQUEST_BYTES=8192,REPORT_BYTES=65536,RECORD_BYTES=131072,MAX_COUNT=4096;
const SHA=/^[a-f0-9]{64}$/,CHANNEL=/^[a-f0-9]{32}$/,QUERY_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const encoder=new TextEncoder();
function fail(code='RBRIDGE_SCOPE_QUIESCENCE_INVALID'):never{throw Error(code);}
function object(input:unknown):Row{if(input===null||typeof input!=='object'||Array.isArray(input))fail();return input as Row;}
/** Every contract is object/scalar/null JSON. Snapshot before crypto; never run getters or toJSON. */
function snapshot(input:unknown,depth=0):unknown {
  if(depth>16)fail();
  if(input===null||typeof input==='string'||typeof input==='boolean')return input;
  if(typeof input==='number'){if(!Number.isSafeInteger(input))fail();return input;}
  if(typeof input!=='object'||Array.isArray(input))fail();
  const proto:unknown=Object.getPrototypeOf(input);if(proto!==Object.prototype&&proto!==null)fail();
  const keys=Reflect.ownKeys(input);if(keys.length>64)fail();const out:Row=Object.create(null) as Row;
  for(const key of keys){
    if(typeof key!=='string'||key==='__proto__'||key==='toJSON'||!/^[\x20-\x7e]+$/.test(key))fail();
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!descriptor||!descriptor.enumerable||!('value' in descriptor))fail();
    out[key]=snapshot(descriptor.value,depth+1);
  }
  return Object.fromEntries(Object.entries(out));
}
function bounded(input:unknown,max:number):Row {
  const row=object(snapshot(input));if(encoder.encode(JSON.stringify(row)).byteLength>max)fail('RBRIDGE_SCOPE_QUIESCENCE_BUDGET_EXCEEDED');return row;
}
function exact(row:Row,keys:readonly string[]):void {
  const actual=Object.keys(row);if(actual.length!==keys.length||actual.some(key=>!keys.includes(key)))fail();
}
function literal(row:Row,schema:string):void{if(row.schema!==schema)fail();}
function scalar(input:unknown,re:RegExp):string{if(typeof input!=='string'||re.exec(input)?.[0]!==input)fail();return input;}
function integer(input:unknown,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof input!=='number'||!Number.isSafeInteger(input)||input<0||input>max)fail();return input;
}
function iso(input:unknown):string {
  const value=scalar(input,ISO),ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail();return value;
}
function boolean(input:unknown):void{if(typeof input!=='boolean')fail();}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
async function digest(row:Row,field='sha256'):Promise<void> {
  const expected=scalar(row[field],SHA),{[field]:_unused,...body}=row;void _unused;
  if(await canonicalDigest(body)!==expected)fail('RBRIDGE_SCOPE_QUIESCENCE_DIGEST_INVALID');
}
function stopShape(input:unknown,expectedScope:V3Scope):Row {
  const row=object(input);exact(row,['schema','requestId','scope','challenge','issuedAt','requestDigest']);
  literal(row,'RBRIDGE_SCOPE_STOP_REQUEST_V1');scalar(row.requestId,ID);scalar(row.challenge,SHA);scalar(row.requestDigest,SHA);iso(row.issuedAt);
  if(!same(parseV3Scope(row.scope),expectedScope))fail('RBRIDGE_SCOPE_STOP_SCOPE_MISMATCH');return row;
}
export async function parseScopeStopRequest(input:unknown,expectedScope:V3Scope):Promise<RbridgeScopeStopRequestV1> {
  const row=bounded(input,REQUEST_BYTES),scope=parseV3Scope(snapshot(expectedScope));stopShape(row,scope);
  const {requestDigest,...body}=row;if(await canonicalDigest(body)!==requestDigest)fail('RBRIDGE_SCOPE_STOP_DIGEST_INVALID');
  return row as unknown as RbridgeScopeStopRequestV1;
}
export async function buildScopeStopRequest(input:ScopeStopRequestInputV1):Promise<RbridgeScopeStopRequestV1> {
  const row=bounded(input,REQUEST_BYTES);exact(row,['requestId','scope','challenge','issuedAt']);
  const scope=parseV3Scope(row.scope),body={schema:'RBRIDGE_SCOPE_STOP_REQUEST_V1' as const,...row};
  return await parseScopeStopRequest({...body,requestDigest:await canonicalDigest(body)},scope);
}
function queryShape(input:unknown):Row {
  const row=object(input);exact(row,['schema','queryId','queryNonce','request','channelId','peerPinsSha256','submittedAt','expiresAt','sha256']);
  literal(row,'RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1');scalar(row.queryId,QUERY_ID);scalar(row.queryNonce,SHA);scalar(row.channelId,CHANNEL);scalar(row.peerPinsSha256,SHA);scalar(row.sha256,SHA);
  const submittedAt=integer(row.submittedAt),expiresAt=integer(row.expiresAt);
  if(!Number.isSafeInteger(submittedAt+RBRIDGE_SCOPE_QUIESCENCE_TTL_MS)||expiresAt!==submittedAt+RBRIDGE_SCOPE_QUIESCENCE_TTL_MS)fail();
  const request=object(row.request);stopShape(request,parseV3Scope(request.scope));return row;
}
/** Parses retained evidence; current transport authority is deliberately checked separately. */
export async function parseScopeQuiescenceQuery(input:unknown):Promise<RbridgeScopeQuiescenceQueryV1> {
  const row=queryShape(bounded(input,REQUEST_BYTES)),request=object(row.request);
  await parseScopeStopRequest(request,parseV3Scope(request.scope));await digest(row);
  return row as unknown as RbridgeScopeQuiescenceQueryV1;
}
export async function buildScopeQuiescenceQuery(input:ScopeQuiescenceQueryInputV1):Promise<RbridgeScopeQuiescenceQueryV1> {
  const row=bounded(input,REQUEST_BYTES);exact(row,['queryId','queryNonce','request','channelId','peerPinsSha256','submittedAt']);
  const submittedAt=integer(row.submittedAt),expiresAt=submittedAt+RBRIDGE_SCOPE_QUIESCENCE_TTL_MS;
  if(!Number.isSafeInteger(expiresAt))fail();
  const body={schema:'RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1' as const,...row,expiresAt};
  return await parseScopeQuiescenceQuery({...body,sha256:await canonicalDigest(body)});
}
/** Use after parsing and correlating the expected complete query; digests alone are not authentication. */
export function assertScopeQuiescenceQueryCurrent(query:RbridgeScopeQuiescenceQueryV1,input:RbridgeScopeQuiescenceCurrentV1):void {
  const row=queryShape(bounded(query,REQUEST_BYTES)),current=bounded(input,REQUEST_BYTES);
  exact(current,['scope','channelId','peerPinsSha256','now']);const scope=parseV3Scope(current.scope);
  scalar(current.channelId,CHANNEL);scalar(current.peerPinsSha256,SHA);const now=integer(current.now);
  if(!same(object(row.request).scope,scope))fail('RBRIDGE_SCOPE_QUIESCENCE_SCOPE_MISMATCH');
  if(row.channelId!==current.channelId)fail('RBRIDGE_SCOPE_QUIESCENCE_CHANNEL_CHANGED');
  if(row.peerPinsSha256!==current.peerPinsSha256)fail('RBRIDGE_SCOPE_QUIESCENCE_PIN_MISMATCH');
  if(now<Number(row.submittedAt)||now>=Number(row.expiresAt))fail('RBRIDGE_SCOPE_QUIESCENCE_STALE');
}
export async function parseScopeResultInventory(input:unknown,expectedScope:V3Scope):Promise<RbridgeScopeResultInventoryV1> {
  const row=bounded(input,REPORT_BYTES),scope=parseV3Scope(snapshot(expectedScope));
  exact(row,['schema','scope','entryCount','unresolvedCount','entriesSha256','sha256']);literal(row,'RBRIDGE_SCOPE_RESULT_INVENTORY_V1');
  if(!same(parseV3Scope(row.scope),scope))fail('RBRIDGE_SCOPE_QUIESCENCE_SCOPE_MISMATCH');
  const entryCount=integer(row.entryCount,MAX_COUNT),unresolvedCount=integer(row.unresolvedCount,MAX_COUNT);if(unresolvedCount>entryCount)fail();
  scalar(row.entriesSha256,SHA);await digest(row);return row as unknown as RbridgeScopeResultInventoryV1;
}
export async function buildScopeResultInventory(input:ScopeResultInventoryInputV1):Promise<RbridgeScopeResultInventoryV1> {
  const row=bounded(input,REPORT_BYTES);exact(row,['scope','entryCount','unresolvedCount','entriesSha256']);const scope=parseV3Scope(row.scope);
  const body={schema:'RBRIDGE_SCOPE_RESULT_INVENTORY_V1' as const,...row};
  return await parseScopeResultInventory({...body,sha256:await canonicalDigest(body)},scope);
}
function eventHead(input:unknown):void {
  const row=object(input);exact(row,['sequence','eventSha256']);const sequence=integer(row.sequence);
  if(sequence===0){if(row.eventSha256!==null)fail();}else scalar(row.eventSha256,SHA);
}
async function fence(input:unknown,request:RbridgeScopeStopRequestV1):Promise<void> {
  const row=object(input);exact(row,['schema','state','request','recordedAt','sha256']);literal(row,'RBRIDGE_SCOPE_STOP_FENCE_V1');
  if(row.state!=='STOP_REQUESTED')fail();iso(row.recordedAt);
  await parseScopeStopRequest(row.request,request.scope);if(!same(row.request,request))fail('RBRIDGE_SCOPE_QUIESCENCE_REQUEST_MISMATCH');await digest(row);
}
const WORKER_FACTS=['fence','sealed','captureStopped','pendingHandlers','pendingReaders','pendingEgress','unresolvedCaptureCount','resultInventory','eventHead','observedAt'] as const;
export async function parseWorkerQuiescenceReport(input:unknown,queryInput:RbridgeScopeQuiescenceQueryV1):Promise<RbridgeWorkerQuiescenceReportV1> {
  const row=bounded(input,REPORT_BYTES),capturedQuery=bounded(queryInput,REQUEST_BYTES);exact(row,['schema','querySha256',...WORKER_FACTS,'sha256']);
  literal(row,'RBRIDGE_SCOPE_QUIESCENCE_WORKER_V1');const query=await parseScopeQuiescenceQuery(capturedQuery);
  if(scalar(row.querySha256,SHA)!==query.sha256)fail('RBRIDGE_SCOPE_QUIESCENCE_QUERY_MISMATCH');
  boolean(row.sealed);boolean(row.captureStopped);
  for(const key of ['pendingHandlers','pendingReaders','pendingEgress','unresolvedCaptureCount'])integer(row[key],MAX_COUNT);
  eventHead(row.eventHead);iso(row.observedAt);await fence(row.fence,query.request);await parseScopeResultInventory(row.resultInventory,query.request.scope);await digest(row);
  return row as unknown as RbridgeWorkerQuiescenceReportV1;
}
export async function buildWorkerQuiescenceReport(queryInput:RbridgeScopeQuiescenceQueryV1,input:WorkerQuiescenceFactsV1):Promise<RbridgeWorkerQuiescenceReportV1> {
  const row=bounded(input,REPORT_BYTES),capturedQuery=bounded(queryInput,REQUEST_BYTES);exact(row,WORKER_FACTS);
  const query=await parseScopeQuiescenceQuery(capturedQuery),body={schema:'RBRIDGE_SCOPE_QUIESCENCE_WORKER_V1' as const,querySha256:query.sha256,...row};
  return await parseWorkerQuiescenceReport({...body,sha256:await canonicalDigest(body)},query);
}
const NATIVE_FACTS=['worker','resultInventory','eventHead','observedAt'] as const;
export async function parseNativeQuiescenceReport(input:unknown,queryInput:RbridgeScopeQuiescenceQueryV1):Promise<RbridgeNativeQuiescenceReportV1> {
  const row=bounded(input,REPORT_BYTES),capturedQuery=bounded(queryInput,REQUEST_BYTES);exact(row,['schema','querySha256',...NATIVE_FACTS,'sha256']);
  literal(row,'RBRIDGE_SCOPE_QUIESCENCE_NATIVE_V1');const query=await parseScopeQuiescenceQuery(capturedQuery);
  if(scalar(row.querySha256,SHA)!==query.sha256)fail('RBRIDGE_SCOPE_QUIESCENCE_QUERY_MISMATCH');
  eventHead(row.eventHead);iso(row.observedAt);await parseWorkerQuiescenceReport(row.worker,query);await parseScopeResultInventory(row.resultInventory,query.request.scope);await digest(row);
  return row as unknown as RbridgeNativeQuiescenceReportV1;
}
export async function buildNativeQuiescenceReport(queryInput:RbridgeScopeQuiescenceQueryV1,input:NativeQuiescenceFactsV1):Promise<RbridgeNativeQuiescenceReportV1> {
  const row=bounded(input,REPORT_BYTES),capturedQuery=bounded(queryInput,REQUEST_BYTES);exact(row,NATIVE_FACTS);
  const query=await parseScopeQuiescenceQuery(capturedQuery),body={schema:'RBRIDGE_SCOPE_QUIESCENCE_NATIVE_V1' as const,querySha256:query.sha256,...row};
  return await parseNativeQuiescenceReport({...body,sha256:await canonicalDigest(body)},query);
}
/** COMPLETE records receipt of factual observations; it never means quiescence PASS. */
export async function parseScopeQuiescenceRecord(input:unknown):Promise<RbridgeScopeQuiescenceRecordV1> {
  const row=bounded(input,RECORD_BYTES);exact(row,['schema','query','state','nativeReport','receivedAt','sha256']);literal(row,'RBRIDGE_SCOPE_QUIESCENCE_RECORD_V1');
  const query=await parseScopeQuiescenceQuery(row.query);
  if(row.state==='COMPLETE'){
    const receivedAt=integer(row.receivedAt);if(receivedAt<query.submittedAt||receivedAt>=query.expiresAt||row.nativeReport===null)fail();
    await parseNativeQuiescenceReport(row.nativeReport,query);
  }else if((row.state!=='QUEUED'&&row.state!=='DISPATCHED')||row.nativeReport!==null||row.receivedAt!==null)fail();
  await digest(row);return row as unknown as RbridgeScopeQuiescenceRecordV1;
}
export async function buildScopeQuiescenceRecord(input:ScopeQuiescenceRecordInputV1):Promise<RbridgeScopeQuiescenceRecordV1> {
  const row=bounded(input,RECORD_BYTES);exact(row,['query','state','nativeReport','receivedAt']);
  const body={schema:'RBRIDGE_SCOPE_QUIESCENCE_RECORD_V1' as const,...row};
  return await parseScopeQuiescenceRecord({...body,sha256:await canonicalDigest(body)});
}
