import {createHash} from 'node:crypto';
import {parseRemoteBridgeRequest,remoteBridgeRequestDigest} from '../domain/remoteBridgeProtocol.js';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest} from '../domain/remoteBridgeStage2Protocol.js';
import {gateReport,installHash,type GateContext} from './gateContext.js';
import {parseStrictJson} from './strictJson.js';
import type {GateReport,IssueEvidence} from './types.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/,HASH=/^[0-9a-f]{64}$/;
function fail(code:string):never{throw new Error(code);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('LEGACY_RECORD_INVALID');return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]){if(required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>![...required,...optional].includes(k)))fail('LEGACY_FIELDS_INVALID');}
function date(value:unknown):number{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('LEGACY_TIMESTAMP_INVALID');return Date.parse(value);}
function terminalStatus(row:Record<string,unknown>){if(row.timed_out===true||row.truncated===true||row.state==='UNCERTAIN')return 'UNCERTAIN';if(row.state==='SUCCEEDED')return 'PASS';if(row.state==='FAILED')return 'FAIL';if(row.state==='BLOCKED')return 'BLOCKED';return 'UNCERTAIN';}
interface ParsedRecord{row:Record<string,unknown>;result:Record<string,unknown>|undefined;}
function parseRecord(value:unknown,path:string):ParsedRecord{
  const r=object(value);fields(r,['schema','requestId','requestSha256','issueNumber','jobId','phase','createdAt','updatedAt'],['scopeSha256','result']);
  if(r.schema!=='COCWIN_REMOTE_BRIDGE_STORE_V1'||typeof r.requestId!=='string'||!ID.test(r.requestId)||path!==r.requestId+'.json'||typeof r.requestSha256!=='string'||!HASH.test(r.requestSha256)||!Number.isSafeInteger(r.issueNumber)||Number(r.issueNumber)<1||typeof r.jobId!=='string'||! /^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.jobId)||!['CLAIMED','SUBMITTED','TERMINAL','PUBLISHED'].includes(String(r.phase)))fail('LEGACY_RECORD_INVALID');
  if(date(r.updatedAt)<date(r.createdAt))fail('LEGACY_TIME_ORDER');
  if(Object.hasOwn(r,'scopeSha256')&&(typeof r.scopeSha256!=='string'||!HASH.test(r.scopeSha256)))fail('LEGACY_SCOPE_INVALID');
  const terminal=['TERMINAL','PUBLISHED'].includes(String(r.phase));
  if(terminal!==Object.hasOwn(r,'result'))fail('LEGACY_PHASE_RESULT_MISMATCH');
  if(!terminal)return {row:r,result:undefined};
  const result=object(r.result);fields(result,['schema','requestId','issueNumber','status','requestSha256','completedAt'],['resultSha256','controllerResult','operationResult','reason']);
  if(!['COCWIN_REMOTE_BRIDGE_RESULT_V1','COCWIN_REMOTE_BRIDGE_RESULT_V2'].includes(String(result.schema))||result.requestId!==r.requestId||result.issueNumber!==r.issueNumber||result.requestSha256!==r.requestSha256||!['PASS','FAIL','BLOCKED','UNCERTAIN'].includes(String(result.status)))fail('LEGACY_RESULT_INVALID');
  if(date(result.completedAt)<date(r.createdAt)||date(result.completedAt)>date(r.updatedAt))fail('LEGACY_RESULT_TIME_ORDER');
  if(Object.hasOwn(result,'reason')&&(typeof result.reason!=='string'||Buffer.byteLength(result.reason)>2048||result.reason.includes('\0')))fail('LEGACY_RESULT_REASON_INVALID');
  const payloadKey=result.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V1'?'controllerResult':'operationResult',otherKey=payloadKey==='controllerResult'?'operationResult':'controllerResult';
  if(Object.hasOwn(result,otherKey))fail('LEGACY_RESULT_SCHEMA_MISMATCH');
  if(Object.hasOwn(result,payloadKey)){
    if(typeof result.resultSha256!=='string'||!HASH.test(result.resultSha256)||sha(JSON.stringify(result[payloadKey]))!==result.resultSha256)fail('LEGACY_RESULT_DIGEST_MISMATCH');
    const value=result[payloadKey];
    if(payloadKey==='controllerResult'){
      if(terminalStatus(object(value))!==result.status)fail('LEGACY_RESULT_STATUS_MISMATCH');
    }else{
      const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
      if(row?.schema==='RBRIDGE_GITHUB_CORE_RESULT_V1')fail('LEGACY_RECORD_UNEXPECTED_CORE');
      const status=row&&['SUCCEEDED','FAILED','BLOCKED','UNCERTAIN'].includes(String(row.state))?terminalStatus(row):'PASS';
      if(status!==result.status)fail('LEGACY_RESULT_STATUS_MISMATCH');
    }
  }else if(Object.hasOwn(result,'resultSha256')||result.status==='PASS'||typeof result.reason!=='string'||!result.reason)fail('LEGACY_NO_RESULT_INVALID');
  return {row:r,result};
}
function issueIdentity(issue:IssueEvidence,context:GateContext,requestId:unknown){
  const base=Object.fromEntries(Object.entries(issue).filter(([k])=>k!=='capture_sha256'));
  if(Object.keys(issue).sort().join(',')!=='author,body,capture_sha256,isPullRequest,number,state,title,updatedAt,url'||issue.capture_sha256!==installHash(base)||!Number.isSafeInteger(issue.number)||issue.number<1||!['OPEN','CLOSED'].includes(issue.state)||issue.isPullRequest!==false||issue.author!==context.profile.binding.author||issue.url!==`https://github.com/${context.profile.binding.repository}/issues/${issue.number}`||issue.title!=='[COCWIN BRIDGE REQUEST] '+requestId||typeof issue.body!=='string'||Buffer.byteLength(issue.body)>65536)fail('LEGACY_ISSUE_IDENTITY_OR_BODY_INVALID');
  date(issue.updatedAt);
}
function request(context:GateContext,issue:IssueEvidence,now:Date,allowExpired:boolean){
  const raw=object(parseStrictJson(issue.body)),b=context.profile.binding;
  if(raw.schema!=='COCWIN_REMOTE_BRIDGE_REQUEST_V2'){
    const parsed=parseRemoteBridgeRequest({title:issue.title,body:issue.body,authorLogin:issue.author,expectedAuthorLogin:b.author,now,allowExpired});
    return {parsed,digest:remoteBridgeRequestDigest(parsed),schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',jobId:parsed.jobId};
  }
  const parsed=parseRemoteBridgeRequestV2({title:issue.title,body:issue.body,author:issue.author,repository:b.repository,expectedAuthor:b.author,expectedRepository:b.repository,now,allowExpired});
  const digest=remoteBridgeRequestV2Digest(parsed);return {parsed,digest,schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',jobId:parsed.operation.kind==='APP_RUN'?parsed.operation.jobId:'host-'+digest.slice(0,48)};
}
export async function collectLegacyIssueNumbers(context:GateContext):Promise<readonly number[]>{
  await context.snapshot.verify();
  if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes||context.snapshot.reasonCodes.length)fail('LEGACY_DISCOVERY_SNAPSHOT_UNQUALIFIED');
  const numbers=new Set<number>(),started=performance.now();
  for(const entry of context.snapshot.entries.filter(e=>!e.path.includes('/'))){
    if(performance.now()-started>=context.profile.budget.scan_ms)fail('LEGACY_SCAN_DEADLINE');
    if(entry.kind==='DIRECTORY'){
      if(!['flowpilot','sessions','transfers','execution-v2'].includes(entry.path))fail('LEGACY_UNKNOWN_ROOT');continue;
    }
    if(entry.path==='relay.lock'){
      if(entry.kind!=='FILE'||entry.nlink!==1||entry.size>32||!/^[1-9][0-9]*\n?$/.test((await context.snapshot.read(entry.path,32)).toString('utf8')))fail('LEGACY_RELAY_LOCK_UNCLASSIFIED');continue;
    }
    if(entry.kind!=='FILE'||entry.nlink!==1||!entry.path.endsWith('.json')||entry.size>context.profile.budget.record_bytes)fail('LEGACY_UNKNOWN_OR_OVERSIZED_RECORD');
    const row=parseRecord(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(await context.snapshot.read(entry.path))),entry.path).row;
    if(Number(row.issueNumber)>2147483647)fail('LEGACY_LOOKUP_NUMBER_INVALID');numbers.add(Number(row.issueNumber));
  }
  await context.snapshot.verify();return Object.freeze([...numbers].sort((a,b)=>a-b));
}

export async function auditLegacyGate(context:GateContext):Promise<GateReport>{
  const evidence:Array<{path:string;file_sha256:string;issue_capture_sha256:string;branch:string}>=[];
  try{
    await context.snapshot.verify();
    if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes)fail('LEGACY_SNAPSHOT_MISMATCH');
    const lookup=context.lookup,b=context.profile.binding;
    if(lookup.status!=='PASS'||lookup.viewer!==b.author||lookup.repository!==b.repository||lookup.profile_sha256!==installHash(context.profile)||lookup.snapshot_sha256!==installHash(context.token)||lookup.capture_sha256!==installHash(context.issues)||(context.snapshot.scope==='QUALIFIED_READONLY_HELPER'&&lookup.scope!=='QUALIFIED_GITHUB_READ'))return gateReport(context,'LEGACY','UNKNOWN',['LEGACY_AUTHENTICATED_LOOKUP_REQUIRED']);
    if(context.snapshot.reasonCodes.length)return gateReport(context,'LEGACY','BLOCKED',context.snapshot.reasonCodes);
    const issues=new Map<number,IssueEvidence>();for(const issue of context.issues){if(issues.has(issue.number))fail('LEGACY_LOOKUP_DUPLICATE');issues.set(issue.number,issue);}
    const expectedScope=sha(JSON.stringify({repository:b.repository,authorLogin:b.author,instanceId:b.target_instance_id}));let unresolvedOpen=false;
    for(const entry of context.snapshot.entries.filter(e=>!e.path.includes('/'))){
      if(entry.kind==='DIRECTORY'){
        if(!['flowpilot','sessions','transfers','execution-v2'].includes(entry.path))fail('LEGACY_UNKNOWN_ROOT');continue;
      }
      if(entry.path==='relay.lock'){
        if(entry.kind!=='FILE'||entry.nlink!==1||entry.size>32||! /^[1-9][0-9]*\n?$/.test((await context.snapshot.read(entry.path,32)).toString('utf8')))fail('LEGACY_RELAY_LOCK_UNCLASSIFIED');continue;
      }
      if(entry.kind!=='FILE'||entry.nlink!==1||!entry.path.endsWith('.json')||entry.size>context.profile.budget.record_bytes)fail('LEGACY_UNKNOWN_OR_OVERSIZED_RECORD');
      const bytes=await context.snapshot.read(entry.path),parsed=parseRecord(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),entry.path),r=parsed.row;
      if(Object.hasOwn(r,'scopeSha256')&&r.scopeSha256!==expectedScope)fail('LEGACY_SCOPE_MISMATCH');
      const issue=issues.get(Number(r.issueNumber));if(!issue)return gateReport(context,'LEGACY','UNKNOWN',['LEGACY_LOOKUP_OMISSION']);issueIdentity(issue,context,r.requestId);
      const now=new Date(context.token.captured_at);let admitted:ReturnType<typeof request>|undefined;
      try{admitted=request(context,issue,now,true);}catch{/* A raw pre-claim rejection has a distinct verified branch. */}
      let branch='ADMITTED_CANONICAL_REQUEST';
      if(admitted&&admitted.digest===r.requestSha256){
        if(admitted.parsed.requestId!==r.requestId||admitted.jobId!==r.jobId||(parsed.result&&parsed.result.schema!==admitted.schema))fail('LEGACY_REQUEST_OR_JOB_MISMATCH');
      }else{
        const result=parsed.result;
        if(r.phase!=='PUBLISHED'||issue.state!=='CLOSED'||!result||result.status!=='BLOCKED'||Object.hasOwn(result,'controllerResult')||Object.hasOwn(result,'operationResult')||r.requestSha256!==sha(issue.body))fail('LEGACY_REQUEST_BODY_CHANGED');
        const raw=object(parseStrictJson(issue.body)),expectedSchema=raw.schema==='COCWIN_REMOTE_BRIDGE_REQUEST_V2'?'COCWIN_REMOTE_BRIDGE_RESULT_V2':'COCWIN_REMOTE_BRIDGE_RESULT_V1';
        if(result.schema!==expectedSchema||(admitted&&(admitted.parsed.requestId!==r.requestId||admitted.jobId!==r.jobId)))fail('LEGACY_REQUEST_OR_JOB_MISMATCH');
        let rejected='';try{request(context,issue,new Date(String(result.completedAt)),false);}catch(error){rejected=error instanceof Error?error.message:'';}
        if(!rejected.startsWith('REMOTE_BRIDGE_')||result.reason!==rejected)fail('LEGACY_RAW_REJECTION_CONTEXT_INVALID');
        branch='CLOSED_RAW_BODY_PRECLAIM_REJECTION';
      }
      if(r.phase!=='PUBLISHED'&&issue.state==='OPEN')unresolvedOpen=true;
      evidence.push({path:entry.path,file_sha256:entry.sha256,issue_capture_sha256:issue.capture_sha256,branch});
    }
    await context.snapshot.verify();
    return gateReport(context,'LEGACY',unresolvedOpen?'BLOCKED':'PASS',unresolvedOpen?['LEGACY_OPEN_UNRESOLVED']:[],[{name:'complete-record-and-body-correlation',status:'PASS',evidence_sha256:installHash(evidence)}],evidence);
  }catch(error){
    const reason=error instanceof Error&&/^(?:LEGACY|STATE|INSTALL_JSON)_[A-Z_]+$/.test(error.message)?error.message:'LEGACY_PARSE_OR_SNAPSHOT_UNAVAILABLE';
    return gateReport(context,'LEGACY',reason.startsWith('STATE_')?'UNKNOWN':'BLOCKED',[reason],[],evidence);
  }
}
