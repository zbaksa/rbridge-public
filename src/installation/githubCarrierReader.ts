import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {parseRemoteBridgeRequest,remoteBridgeRequestDigest} from '../domain/remoteBridgeProtocol.js';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest,type RemoteBridgeStage2Operation} from '../domain/remoteBridgeStage2Protocol.js';
import {canonicalRBridgeJson,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionPolicy} from '../server/rbridgeExecutionPolicy.js';
import {parseRBridgeCarrierJson} from './carrierJson.js';
import {installHash} from './gateContext.js';
import {validateInstallContract} from './types.js';
import type {CarrierCapture,CarrierComment,CarrierEvidence,ReaderExpectation,ReaderResult} from './rbridge-installation-reader.js';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),HASH=/^[0-9a-f]{64}$/,CAP=8519680;
const fence=(v:unknown)=>'```json\n'+JSON.stringify(v,null,2)+'\n```\n';
function fail(code:string):never{throw new Error(code);}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))fail('CARRIER_OBJECT_INVALID');return v as Record<string,unknown>;}
function fields(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]){if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail('CARRIER_FIELDS_INVALID');}
function integer(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)fail('CARRIER_INTEGER_INVALID');return v;}
function text(v:unknown,max=4096):string{if(typeof v!=='string'||Buffer.byteLength(v)>max||v.includes('\0'))fail('CARRIER_STRING_INVALID');return v;}
function hash(v:unknown):string{if(typeof v!=='string'||!HASH.test(v))fail('CARRIER_DIGEST_INVALID');return v;}
function date(v:unknown):Date{const raw=text(v,64),d=new Date(raw);if(!Number.isFinite(d.getTime())||d.toISOString()!==raw)fail('CARRIER_TIMESTAMP_INVALID');return d;}
function base64(v:unknown,max:number):Buffer{if(typeof v!=='string'||v.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))fail('CARRIER_BASE64_INVALID');const b=Buffer.from(v,'base64');if(b.length>max||b.toString('base64')!==v)fail('CARRIER_BASE64_INVALID');return b;}
function canonicalSha(v:unknown){return sha(canonicalRBridgeJson(v as RBridgeJsonValue));}
function authenticate(capture:CarrierCapture,expected:ReaderExpectation){
  validateInstallContract(capture,'CarrierCapture');validateInstallContract(expected,'ReaderExpectation');
  const {capture_sha256:_,...base}=capture;void _;
  if(capture.capture_sha256!==installHash(base)||expected.capture_sha256!==capture.capture_sha256||capture.context_sha256!==expected.capture_context_sha256||capture.repository!==expected.repository||capture.viewer!==expected.author||capture.issue.author!==expected.author||capture.issue.number!==expected.issue_number||capture.issue.url!==`https://github.com/${expected.repository}/issues/${expected.issue_number}`||capture.issue.title!==expected.request_title||sha(capture.issue.body)!==expected.request_body_sha256||Buffer.byteLength(capture.issue.body)>65536||Buffer.byteLength(capture.issue.title)>1024||Buffer.byteLength(JSON.stringify(capture))>67108864)fail('CARRIER_AUTHENTICATION_INVALID');
  const seen=new Set<number>();
  for(const c of capture.comments){if(seen.has(c.id)||c.url!==capture.issue.url+'#issuecomment-'+c.id||Buffer.byteLength(c.body)>65536)fail('CARRIER_COMMENT_IDENTITY_INVALID');seen.add(c.id);}
  if(expected.mode==='CORE'&&(!expected.scope||!expected.intent_sha256||!expected.policy_sha256||!expected.runtime_uid||expected.expected_source_sha!==expected.producer_source_sha||expected.digest_branch!=='ADMITTED_CANONICAL_REQUEST'))fail('CARRIER_CORE_EXPECTATION_REQUIRED');
}
interface Candidate{bytes:Buffer;row:Record<string,unknown>;comments:CarrierComment[];receipts:CarrierComment[];}
function candidates(capture:CarrierCapture,expected:ReaderExpectation):Candidate[]{
  const direct:Candidate[]=[],manifests:Array<{row:Record<string,unknown>;comment:CarrierComment}>=[],chunks:Array<{row:Record<string,unknown>;comment:CarrierComment}>=[];
  for(const comment of capture.comments){
    if(!comment.body.startsWith('```json\n'))continue;
    if(!comment.body.endsWith('\n```\n'))fail('CARRIER_FENCE_INVALID');
    const row=object(parseRBridgeCarrierJson(Buffer.from(comment.body.slice(8,-5)),65536));
    if(typeof row.schema!=='string'||!row.schema.startsWith('COCWIN_REMOTE_BRIDGE_RESULT_'))continue;
    if(comment.author!==expected.author||Buffer.byteLength(comment.body)>=60000||comment.body!==fence(row))fail('CARRIER_COMMENT_AUTHENTICATION_INVALID');
    if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V1'||row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V2'){
      if(row.requestId!==expected.request_id)fail('CARRIER_REQUEST_ID_INVALID');
      const bytes=Buffer.from(JSON.stringify(row));if(bytes.length>CAP)fail('CARRIER_ENVELOPE_LIMIT');direct.push({bytes,row,comments:[comment],receipts:[comment]});
    }else if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1')manifests.push({row,comment});
    else if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1')chunks.push({row,comment});
    else fail('CARRIER_SCHEMA_INVALID');
  }
  const assembled:Candidate[]=[];const used=new Set<number>();
  for(const {row:m,comment} of manifests){
    fields(m,['schema','transferId','count','totalBytes','objectSha256']);const objectSHA=hash(m.objectSha256),total=integer(m.totalBytes,1,CAP),count=integer(m.count,1,expected.mode==='CORE'?256:1024);
    if(m.transferId!=='result-'+objectSHA||count!==Math.ceil(total/40000))fail('CARRIER_MANIFEST_INVALID');
    const parts=new Map<number,Buffer>(),comments=[comment];
    for(const {row:c,comment:cc} of chunks){
      if(c.transferId!==m.transferId)continue;
      fields(c,['schema','transferId','index','count','dataBase64','chunkSha256','objectSha256']);const index=integer(c.index,0,count-1),part=base64(c.dataBase64,40000);
      if(c.count!==count||c.objectSha256!==objectSHA||hash(c.chunkSha256)!==sha(part)||part.length!==(index===count-1?total-index*40000:40000))fail('CARRIER_CHUNK_INVALID');
      const previous=parts.get(index);if(previous&&!previous.equals(part))fail('CARRIER_CHUNK_CONFLICT');parts.set(index,part);comments.push(cc);used.add(cc.id);
    }
    if(parts.size!==count)fail('CARRIER_CHUNK_MISSING');
    const bytes=Buffer.concat(Array.from({length:count},(_,i)=>parts.get(i)!),total);
    if(sha(bytes)!==objectSHA)fail('CARRIER_WHOLE_DIGEST_INVALID');
    const row=object(parseRBridgeCarrierJson(bytes,CAP));
    if(!bytes.equals(Buffer.from(JSON.stringify(row)))||Buffer.byteLength(fence(row))<60000)fail('CARRIER_CHUNK_FORMAT_INVALID');
    assembled.push({bytes,row,comments,receipts:[comment]});
  }
  if(chunks.some(c=>!used.has(c.comment.id)))fail('CARRIER_ORPHAN_CHUNK');
  const all=[...direct,...assembled];if(all.some(c=>!c.bytes.equals(all[0]!.bytes)))fail('CARRIER_RESULT_CONFLICT');
  if(!all.length)return [];
  return [{...all[0]!,comments:all.flatMap(c=>c.comments).filter((c,i,a)=>a.findIndex(x=>x.id===c.id)===i),receipts:all.flatMap(c=>c.receipts)}];
}
function admitted(capture:CarrierCapture,row:Record<string,unknown>,allowExpired=true){
  const parsed=object(parseRBridgeCarrierJson(Buffer.from(capture.issue.body),65536)),now=date(row.completedAt),i=capture.issue;
  if(parsed.schema==='COCWIN_REMOTE_BRIDGE_REQUEST_V2'){
    const request=parseRemoteBridgeRequestV2({title:i.title,body:i.body,author:i.author,repository:capture.repository,expectedAuthor:capture.viewer,expectedRepository:capture.repository,now,allowExpired});
    return {request,digest:remoteBridgeRequestV2Digest(request),schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',operation:request.operation};
  }
  const request=parseRemoteBridgeRequest({title:i.title,body:i.body,authorLogin:i.author,expectedAuthorLogin:capture.viewer,now,allowExpired});
  return {request,digest:remoteBridgeRequestDigest(request),schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',operation:{kind:'APP_RUN' as const,appId:request.appId,jobId:request.jobId,payload:request.payload}};
}
function rawRejection(capture:CarrierCapture,row:Record<string,unknown>){
  if(row.status!=='BLOCKED'||row.requestSha256!==sha(capture.issue.body))fail('CARRIER_RAW_REJECTION_INVALID');
  let parsed:unknown,jsonValid=false;try{parsed=JSON.parse(capture.issue.body);jsonValid=true;}catch{/* Pinned worker classifies malformed JSON as V1. */}
  if(jsonValid)parseRBridgeCarrierJson(Buffer.from(capture.issue.body),65536);
  const isV2=parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed)&&(parsed as Record<string,unknown>).schema==='COCWIN_REMOTE_BRIDGE_REQUEST_V2';
  if(row.schema!==(isV2?'COCWIN_REMOTE_BRIDGE_RESULT_V2':'COCWIN_REMOTE_BRIDGE_RESULT_V1'))fail('CARRIER_RAW_SCHEMA_INVALID');
  const i=capture.issue,now=date(row.completedAt);let reason='';
  try{if(isV2)parseRemoteBridgeRequestV2({title:i.title,body:i.body,author:i.author,repository:capture.repository,expectedAuthor:capture.viewer,expectedRepository:capture.repository,now});else parseRemoteBridgeRequest({title:i.title,body:i.body,authorLogin:i.author,expectedAuthorLogin:capture.viewer,now});}
  catch(error){reason=error instanceof Error?error.message:'';}
  const prefix='[COCWIN BRIDGE REQUEST] ',suffix=i.title.startsWith(prefix)?i.title.slice(prefix.length):'',id=/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(suffix)?suffix:'issue-'+i.number;
  if(!reason.startsWith('REMOTE_BRIDGE_')||row.reason!==reason||row.requestId!==id)fail('CARRIER_RAW_REJECTION_CONTEXT_INVALID');
}
function appStatus(row:Record<string,unknown>){return row.timed_out===true||row.truncated===true||row.state==='UNCERTAIN'?'UNCERTAIN':row.state==='SUCCEEDED'?'PASS':row.state==='FAILED'?'FAIL':row.state==='BLOCKED'?'BLOCKED':'UNCERTAIN';}
function operationOutput(operation:RemoteBridgeStage2Operation,output:unknown,source:string,mode:'LEGACY'|'CORE'){
  const row=object(output);
  const readLimit=mode==='CORE'?1048576:16777216;
  if(operation.kind==='HEALTH'){
    fields(row,['schema','status','releaseSha','uptimeMs','queueCount','sessionCount','transferCount','lastGitHubPollAt']);
    if(row.schema!=='COCWIN_REMOTE_BRIDGE_HEALTH_V2'||row.status!=='PASS'||row.releaseSha!==source)fail('CARRIER_HEALTH_BINDING_INVALID');integer(row.uptimeMs);for(const k of ['queueCount','sessionCount','transferCount'])integer(row[k],0,1000000);if(row.lastGitHubPollAt!==null)date(row.lastGitHubPollAt);return;
  }
  if(operation.kind==='APP_RUN'){
    if((Object.hasOwn(row,'app')&&row.app!==operation.appId)||(Object.hasOwn(row,'job')&&row.job!==operation.jobId))fail('CARRIER_APP_BINDING_INVALID');return;
  }
  if(operation.kind!=='FILE')return;
  const path=()=>{if(row.path!==operation.target)fail('CARRIER_FILE_PATH_INVALID');};
  if(operation.action==='READ'){fields(row,['path','text']);path();text(row.text,readLimit);}
  else if(operation.action==='STAT'){fields(row,['path','type','size','mtimeMs']);path();if(!['file','directory','symlink','other'].includes(String(row.type)))fail('CARRIER_FILE_TYPE_INVALID');integer(row.size);integer(row.mtimeMs,-Number.MAX_SAFE_INTEGER);}
  else if(operation.action==='READ_BINARY'){fields(row,['path','dataBase64','bytes','sha256']);path();const b=base64(row.dataBase64,readLimit);if(integer(row.bytes)!==b.length||hash(row.sha256)!==sha(b))fail('CARRIER_FILE_BYTES_INVALID');}
  else if(operation.action==='LIST'){fields(row,['path','entries']);path();if(!Array.isArray(row.entries)||row.entries.length>500)fail('CARRIER_FILE_ENTRIES_INVALID');const names=new Set<string>();for(const v of row.entries){const e=object(v);fields(e,['name','type']);const name=text(e.name,255);if(!name||name==='.'||name==='..'||name.includes('/')||names.has(name)||!['file','directory','symlink','other'].includes(String(e.type)))fail('CARRIER_FILE_ENTRIES_INVALID');names.add(name);}}
  else if(operation.action==='READ_MANY'){fields(row,['files']);const paths=operation.args.paths;if(!Array.isArray(paths)||!Array.isArray(row.files)||paths.length<1||paths.length>32||row.files.length!==paths.length)fail('CARRIER_FILE_MANY_INVALID');let bytes=0;for(let n=0;n<paths.length;n++){const f=object(row.files[n]);fields(f,['path','text']);if(typeof paths[n]!=='string'||f.path!==join(operation.target,paths[n] as string))fail('CARRIER_FILE_PATH_INVALID');bytes+=Buffer.byteLength(text(f.text,readLimit));if(bytes>readLimit)fail('CARRIER_FILE_BYTES_INVALID');}}
  else if(operation.action==='SEARCH'){fields(row,['matches','truncated']);if(!Array.isArray(row.matches)||row.matches.length>(mode==='CORE'?500:5000)||typeof row.truncated!=='boolean')fail('CARRIER_FILE_SEARCH_INVALID');for(const v of row.matches){const m=object(v);fields(m,['path']);const p=text(m.path,4096);if(!p.startsWith(operation.target+'/')||p.split('/').some(x=>x==='.'||x==='..'))fail('CARRIER_FILE_PATH_INVALID');}}
}
export function readRBridgeGitHubCarrier(capture:CarrierCapture,expected:ReaderExpectation):ReaderResult{
  try{
    authenticate(capture,expected);const selected=candidates(capture,expected)[0];
    if(!selected)return {scope:'REFERENCE_PARSER_ONLY',kind:'UNAVAILABLE',status:'UNKNOWN',reason_codes:['CARRIER_RESULT_UNAVAILABLE']};
    const r=selected.row;fields(r,['schema','requestId','issueNumber','status','requestSha256','completedAt'],['resultSha256','operationResult','controllerResult','reason']);
    if(r.requestId!==expected.request_id||integer(r.issueNumber,1,2147483647)!==capture.issue.number||!['PASS','FAIL','BLOCKED','UNCERTAIN'].includes(String(r.status)))fail('CARRIER_ENVELOPE_IDENTITY_INVALID');hash(r.requestSha256);date(r.completedAt);if(Object.hasOwn(r,'reason'))text(r.reason,2048);
    const key=r.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V1'?'controllerResult':r.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V2'?'operationResult':fail('CARRIER_SCHEMA_INVALID');if(Object.hasOwn(r,key==='operationResult'?'controllerResult':'operationResult'))fail('CARRIER_RESULT_BRANCH_INVALID');
    const ids=[...new Set(selected.receipts.map(c=>c.id))].sort((a,b)=>a-b),id=expected.selected_comment_id??ids[0]!;
    if(!ids.includes(id))fail('CARRIER_SELECTED_COMMENT_MISSING');
    const comments=[...selected.comments].sort((a,b)=>a.id-b.id),evidence:CarrierEvidence={capture_sha256:capture.capture_sha256,context_sha256:capture.context_sha256,comment_ids:comments.map(c=>c.id),comment_body_sha256:comments.map(c=>sha(c.body)),selected_comment_id:id,envelope_sha256:sha(selected.bytes),raw_envelope_base64:selected.bytes.toString('base64')};
    const base={scope:'REFERENCE_PARSER_ONLY' as const,status:r.status as 'PASS'|'FAIL'|'BLOCKED'|'UNCERTAIN',reason_codes:[],envelope:structuredClone(r),evidence};
    if(!Object.hasOwn(r,key)){
      if(expected.mode!=='LEGACY'||Object.hasOwn(r,'resultSha256')||!['BLOCKED','UNCERTAIN'].includes(String(r.status))||typeof r.reason!=='string'||!r.reason)fail('CARRIER_NO_RESULT_INVALID');
      if(expected.digest_branch==='RAW_BODY_PRECLAIM_REJECTION')rawRejection(capture,r);
      else{const a=admitted(capture,r);if(a.schema!==r.schema||a.request.requestId!==r.requestId||a.digest!==r.requestSha256)fail('CARRIER_REQUEST_DIGEST_INVALID');}
      return {...base,kind:'LEGACY_REJECTION'};
    }
    if(expected.digest_branch!=='ADMITTED_CANONICAL_REQUEST')fail('CARRIER_RESULT_BRANCH_INVALID');
    const a=admitted(capture,r);if(a.schema!==r.schema||a.request.requestId!==r.requestId||a.digest!==r.requestSha256)fail('CARRIER_REQUEST_DIGEST_INVALID');
    if(hash(r.resultSha256)!==sha(JSON.stringify(r[key])))fail('CARRIER_OUTER_RESULT_DIGEST_INVALID');
    const payload=object(r[key]);
    if(payload.schema==='RBRIDGE_GITHUB_CORE_RESULT_V1'){
      if(expected.mode!=='CORE'||key!=='operationResult'||!expected.scope)fail('CARRIER_CORE_EXPECTATION_REQUIRED');fields(payload,['schema','receipt'],['output']);
      const submission=parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...expected.scope,operation:a.operation});if(submission.operationId!==expected.request_id||rbridgeOperationIntentDigest(submission)!==expected.intent_sha256)fail('CARRIER_INTENT_BINDING_INVALID');
      const receipt=parseRBridgeExecutionReceipt(payload.receipt,expected.scope,expected.intent_sha256);
      const policy=createRBridgeExecutionPolicy({runtimeUid:expected.runtime_uid!,principalId:expected.scope.principalId,targetInstanceId:expected.scope.targetInstanceId}).evaluate(submission).snapshot;
      if(canonicalSha(receipt.policy)!==canonicalSha(policy)||policy.policySha256!==expected.policy_sha256)fail('CARRIER_POLICY_BINDING_INVALID');
      if(receipt.phase!=='TERMINAL'||receipt.policy.policySha256!==expected.policy_sha256||receipt.policy.policyVersion!=='safe-core-p2a-v1'||r.status!==(receipt.outcome==='TERMINATED'?'BLOCKED':receipt.outcome)||r.completedAt!==receipt.transitions.at(-1)!.at||r.reason!==(receipt.outcome==='TERMINATED'?'RBRIDGE_CORE_TERMINATED':receipt.reason))fail('CARRIER_RECEIPT_BINDING_INVALID');
      if(expected.receipt_sha256&&canonicalSha(receipt)!==expected.receipt_sha256)fail('CARRIER_ORIGINAL_RECEIPT_CHANGED');
      if(Object.hasOwn(payload,'output')){if(!receipt.resultSha256||canonicalSha(payload.output)!==receipt.resultSha256||(expected.output_sha256&&receipt.resultSha256!==expected.output_sha256))fail('CARRIER_OUTPUT_DIGEST_INVALID');if(receipt.outcome==='PASS')operationOutput(a.operation,payload.output,expected.expected_source_sha,'CORE');}
      else if(receipt.resultSha256||expected.output_sha256||receipt.outcome==='PASS')fail('CARRIER_OUTPUT_MISSING');
      return {...base,kind:'CORE_RESULT',receipt,...(Object.hasOwn(payload,'output')?{output:structuredClone(payload.output)}:{})};
    }
    if(expected.mode!=='LEGACY')fail('CARRIER_LEGACY_EXPECTATION_REQUIRED');
    const status=key==='controllerResult'||a.operation.kind==='APP_RUN'?appStatus(payload):['SUCCEEDED','FAILED','BLOCKED','UNCERTAIN'].includes(String(payload.state))?appStatus(payload):'PASS';
    if(r.status!==status)fail('CARRIER_LEGACY_STATUS_INVALID');operationOutput(a.operation,payload,expected.expected_source_sha,'LEGACY');
    return {...base,kind:'LEGACY_RESULT',output:structuredClone(payload)};
  }catch(error){return {scope:'REFERENCE_PARSER_ONLY',kind:'INVALID',status:'FAIL',reason_codes:[error instanceof Error&&/^CARRIER_[A-Z_]+$/.test(error.message)?error.message:'CARRIER_INPUT_INVALID']};}
}
