/** Fixed local Core/publisher cases. These bytes do not authenticate GitHub. */
import {createHash} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import type {GitHubBridgeIssue,RBridgeGitHubComment,RBridgeGitHubPort} from '../adapters/githubIssueRemoteBridge.js';
import type {createRBridgeGitHubCore} from '../adapters/rbridgeGitHubCore.js';
import type {RBridgeCorePort,RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {canonicalRBridgeJson,parseRBridgeDeploymentBinding} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeJsonValue,type RBridgeOperationSubmissionV1,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {remoteBridgeRequestV2Digest,type RemoteBridgeRequestV2} from '../domain/remoteBridgeStage2Protocol.js';
import type {captureArtifactOperation} from './artifactEvidence.js';
import {parseRBridgeCarrierJson} from './carrierJson.js';
import {installHash} from './gateContext.js';
import type {CarrierCapture,ReaderExpectation} from './rbridge-installation-reader.js';
import {encodeInstallReport} from './types.js';

const SOURCE='b5881fd8367b4249e82683f1f884f2392cb696d4';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fence=(value:unknown)=>'```json\n'+JSON.stringify(value,null,2)+'\n```\n';
function fail(reason='CORE_FIXTURE_INPUT_INVALID'):never{throw new Error(reason);}
type Original=ReturnType<typeof captureArtifactOperation>;
type Issue=GitHubBridgeIssue&{state:'open'|'closed'};
const ports=new WeakSet<object>();
export function createIsolatedCoreCarrierPort(repository:string,author:string){
  if(!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(author))fail();
  const issues=new Map<number,Issue>(),comments=new Map<number,RBridgeGitHubComment[]>();let nextId=1;
  function issue(number:number){const row=issues.get(number);if(!row)fail('CORE_FIXTURE_ISSUE_UNKNOWN');return row;}
  const port:RBridgeGitHubPort&{
    register(number:number,request:RemoteBridgeRequestV2):Issue;
    capture(number:number,context:string):CarrierCapture;
    duplicate(number:number):Promise<void>;
  }={
    register(number,request){
      if(!Number.isSafeInteger(number)||number<101||number>108||issues.has(number))fail();
      const row:Issue={number,title:'[COCWIN BRIDGE REQUEST] '+request.requestId,body:JSON.stringify(request),authorLogin:author,url:'https://github.com/'+repository+'/issues/'+number,state:'open'};
      if(Buffer.byteLength(row.body)>65536)fail();issues.set(number,row);comments.set(number,[]);return structuredClone(row);
    },
    async readIssue(number){return structuredClone(issue(number));},
    async readCommentPage(number,page){issue(number);if(!Number.isSafeInteger(page)||page<1||page>52)fail();return structuredClone(comments.get(number)!.slice((page-1)*20,page*20));},
    async postComment(number,body){
      issue(number);const list=comments.get(number)!;
      if(typeof body!=='string'||Buffer.byteLength(body)>=60000||list.length>=256||nextId>1024)fail();
      const row={id:nextId++,authorLogin:author,body,url:issue(number).url+'#issuecomment-'+(nextId-1)};list.push(row);return structuredClone(row);
    },
    async closeIssue(number){issue(number).state='closed';},
    async duplicate(number){const rows=comments.get(number);if(!rows||rows.length!==1||issue(number).state!=='closed')fail();await port.postComment(number,rows[0]!.body);},
    capture(number,context){
      const row=issue(number),base={schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1' as const,scope:'FIXTURE_AUTHORITY_ONLY' as const,context_sha256:context,repository,viewer:author,
        issue:{number,title:row.title,body:row.body,author:row.authorLogin,url:row.url,state:row.state==='open'?'OPEN' as const:'CLOSED' as const,isPullRequest:false as const},
        comments:comments.get(number)!.map(c=>({id:c.id,author:c.authorLogin,body:c.body,url:c.url})),complete:true as const};
      return {...base,capture_sha256:installHash(base)};
    },
  };ports.add(port);return Object.freeze(port);
}
export interface CoreCarrierCaseInput{
  binding:RBridgeDeploymentBinding;repository:string;author:string;source_sha:typeof SOURCE;context_sha256:string;
  sourceDirectory:string;core:RBridgeCorePort;adapter:ReturnType<typeof createRBridgeGitHubCore>;
  port:ReturnType<typeof createIsolatedCoreCarrierPort>;originals:readonly Original[];deadline_ms:number;
}
interface ProducerCase{
  fixture_id:string;case_id:'C02'|'C03'|'C04'|'C05'|'C06'|'C07'|'C08';transport:'GITHUB';provenance:'SOURCE_PRODUCER';
  capture:CarrierCapture;expected:ReaderExpectation;replayed_at?:string;
  expected_verdict_json:string;expected_verdict_sha256:string;expected_verdict_canonical_sha256:string;
}
/** The oracle assembles expected verdicts from the real Core and publisher preimages;
 * it never invokes the reader whose acceptance will later be checked. */
export async function produceCoreCarrierCases(input:CoreCarrierCaseInput){
  const uid=process.getuid?.();
  if(!uid||process.geteuid?.()!==uid)fail('CORE_FIXTURE_RUNTIME_UNQUALIFIED');
  const binding=parseRBridgeDeploymentBinding(input.binding);
  if(binding.runtimeUid!==uid||input.source_sha!==SOURCE||!ports.has(input.port)||!isAbsolute(input.sourceDirectory)
    ||!/^[0-9a-f]{64}$/.test(input.context_sha256)||!Number.isSafeInteger(input.deadline_ms)||input.deadline_ms<1||input.deadline_ms>180000
    ||!Array.isArray(input.originals)||input.originals.length!==2)fail();
  const directory=await lstat(input.sourceDirectory);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==uid||(directory.mode&0o022))fail();
  const deadline=performance.now()+input.deadline_ms,signal=AbortSignal.timeout(input.deadline_ms),cases:ProducerCase[]=[];
  const ctx:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'GITHUB',authenticatedSubject:input.repository+':'+input.author,principalId:binding.principalId,requestRef:'fixture'};
  const check=()=>{if(signal.aborted||performance.now()>=deadline)fail('CORE_FIXTURE_DEADLINE');};
  const submission=(id:string,operation:unknown):RBridgeOperationSubmissionV1=>parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:id,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation});
  async function terminal(id:string){
    for(;;){check();const found=await input.core.status(id,ctx);if(found.status==='RECEIPT'&&found.receipt.phase==='TERMINAL')return found.receipt;await new Promise<void>(done=>setTimeout(done,5));}
  }
  async function output(receipt:RBridgeExecutionReceiptV1){
    if(!receipt.resultSha256)return undefined;
    const chunks:Buffer[]=[];let cursor=0;
    for(let n=0;n<256;n++){
      check();const page=await input.core.result(receipt.operationId,cursor,32768,ctx);
      if(page.status!=='RESULT'||installHash(page.receipt)!==installHash(receipt)||page.resultSha256!==receipt.resultSha256||page.nextCursor<=cursor&&!page.eof)fail();
      chunks.push(Buffer.from(page.dataBase64,'base64'));cursor=page.nextCursor;
      if(page.eof){const bytes=Buffer.concat(chunks);if(bytes.length!==cursor||sha(bytes)!==receipt.resultSha256)fail();const value=parseRBridgeCarrierJson(bytes,8388608) as RBridgeJsonValue;if(canonicalRBridgeJson(value)!==bytes.toString('utf8'))fail();return value;}
    }fail();
  }
  async function originals(){
    for(const [index,original] of input.originals.entries()){
      if(original.operationId!==(index===0?'artifact-health':'artifact-read')||sha(original.receiptJSON)!==original.receiptSHA256)fail();
      const receipt=await terminal(original.operationId);
      if(sha(encodeInstallReport(receipt))!==original.receiptSHA256||receipt.resultSha256!==original.resultSHA256||sha(Buffer.from(original.resultBase64,'base64'))!==original.resultSHA256
        ||canonicalRBridgeJson((await output(receipt))!)!==original.resultJSON)fail('CORE_FIXTURE_ORIGINAL_CHANGED');
    }
  }
  await originals();
  // Create-only, bounded fixture material. No production path is selected by a request.
  try{await lstat(join(input.sourceDirectory,'core-case-missing.txt'));fail();}catch(error){if(!error||typeof error!=='object'||!('code' in error)||error.code!=='ENOENT')throw error;}
  await writeFile(join(input.sourceDirectory,'core-case-large.txt'),'Core é🙂 fixture\n'.repeat(8192),{mode:0o600,flag:'wx'});
  function request(id:string,operation:RBridgeOperationSubmissionV1['operation'],expired=false):RemoteBridgeRequestV2{
    const now=Date.now();return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:id,createdAt:expired?'2020-01-01T00:00:00.000Z':new Date(now-1000).toISOString(),expiresAt:expired?'2020-01-01T00:20:00.000Z':new Date(now+20*60000).toISOString(),operation};
  }
  function expected(capture:CarrierCapture,s:RBridgeOperationSubmissionV1,receipt?:RBridgeExecutionReceiptV1):ReaderExpectation{
    return {producer_source_sha:SOURCE,mode:'CORE',repository:input.repository,author:input.author,issue_number:capture.issue.number,request_id:s.operationId,request_title:capture.issue.title,
      request_body_sha256:sha(capture.issue.body),capture_context_sha256:input.context_sha256,capture_sha256:capture.capture_sha256,digest_branch:'ADMITTED_CANONICAL_REQUEST',expected_source_sha:SOURCE,
      scope:{operationId:s.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId},runtime_uid:uid!,intent_sha256:rbridgeOperationIntentDigest(s),policy_sha256:JSON.parse(input.originals[0]!.receiptJSON).policy.policySha256 as string,
      ...(receipt?{receipt_sha256:installHash(receipt),...(receipt.resultSha256?{output_sha256:receipt.resultSha256}:{})}:{}),...(capture.comments.length?{selected_comment_id:capture.comments.at(-1)!.id}:{})};
  }
  function add(caseId:ProducerCase['case_id'],suffix:string,capture:CarrierCapture,e:ReaderExpectation,verdict:unknown,replayed_at?:string){
    const raw=JSON.stringify(verdict);cases.push({fixture_id:'core-producer-'+suffix,case_id:caseId,transport:'GITHUB',provenance:'SOURCE_PRODUCER',capture,expected:e,
      ...(replayed_at?{replayed_at}:{}),expected_verdict_json:raw,expected_verdict_sha256:sha(raw),expected_verdict_canonical_sha256:installHash(verdict)});
  }
  async function publish(number:number,req:RemoteBridgeRequestV2){
    check();const issue=input.port.register(number,req),s=submission(req.requestId,req.operation);
    if(await input.adapter.admit(issue)!=='CORE')fail('CORE_FIXTURE_ADMISSION_FAILED');
    const receipt=await terminal(req.requestId);
    for(;;){check();await input.adapter.reconcileDeliveries(20);if((await input.port.readIssue(number)).state==='closed')break;await new Promise<void>(done=>setTimeout(done,5));}
    const value=await output(receipt),payload={schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt,...(value===undefined?{}:{output:value})};
    const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:req.requestId,issueNumber:number,status:receipt.outcome==='TERMINATED'?'BLOCKED':receipt.outcome,requestSha256:remoteBridgeRequestV2Digest(req),resultSha256:sha(JSON.stringify(payload)),operationResult:payload,...(receipt.outcome==='TERMINATED'?{reason:'RBRIDGE_CORE_TERMINATED'}:receipt.reason?{reason:receipt.reason}:{}),completedAt:receipt.transitions.at(-1)!.at};
    return {s,receipt,envelope};
  }
  function positive(caseId:ProducerCase['case_id'],suffix:string,number:number,row:Awaited<ReturnType<typeof publish>>,replayed_at?:string){
    const capture=input.port.capture(number,input.context_sha256),bytes=Buffer.from(JSON.stringify(row.envelope)),count=Buffer.byteLength(fence(row.envelope))<60000?0:Math.ceil(bytes.length/40000),transferId='result-'+sha(bytes);
    const bodies=count?Array.from({length:count},(_,index)=>{const b=bytes.subarray(index*40000,(index+1)*40000);return fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:b.toString('base64'),chunkSha256:sha(b),objectSha256:sha(bytes)});}).concat(fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:bytes.length,objectSha256:sha(bytes)})):[fence(row.envelope)];
    if(!capture.comments.length||bodies.some(body=>!capture.comments.some(c=>c.body===body))||capture.comments.some(c=>!bodies.includes(c.body)))fail('CORE_FIXTURE_PUBLICATION_CHANGED');
    const selected=capture.comments.find(c=>c.body===bodies.at(-1))!.id,e=expected(capture,row.s,row.receipt);e.selected_comment_id=selected;
    const comments=[...capture.comments].sort((a,b)=>a.id-b.id),evidence={capture_sha256:capture.capture_sha256,context_sha256:capture.context_sha256,comment_ids:comments.map(c=>c.id),comment_body_sha256:comments.map(c=>sha(c.body)),selected_comment_id:selected,envelope_sha256:sha(bytes),raw_envelope_base64:bytes.toString('base64')};
    add(caseId,suffix,capture,e,{scope:'REFERENCE_PARSER_ONLY',status:row.envelope.status,reason_codes:[],envelope:row.envelope,evidence,kind:'CORE_RESULT',receipt:row.receipt,...('output'in row.envelope.operationResult?{output:row.envelope.operationResult.output}:{})},replayed_at);
  }
  const healthOp={kind:'HEALTH',action:'STATUS'} as const,fileOp={kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}} as const;
  const health=await publish(101,request('artifact-health',healthOp,true));positive('C02','health',101,health);
  const file=await publish(102,request('artifact-read',fileOp,true));positive('C02','file',102,file);
  const missing=await publish(103,request('core-case-missing',{...fileOp,target:'/mnt/data/core-case-missing.txt'}));positive('C03','missing',103,missing);
  const blocked=await publish(104,request('core-case-argument-block',{...fileOp,args:{unexpected:true}}));positive('C03','blocked',104,blocked);
  const large=await publish(105,request('core-case-large',{...fileOp,target:'/mnt/data/core-case-large.txt'}));positive('C04','large',105,large);
  const digest=structuredClone(cases[0]!),envelope=JSON.parse(digest.capture.comments[0]!.body.slice(8,-5));envelope.resultSha256=health.receipt.resultSha256;digest.capture.comments[0]!.body=fence(envelope);
  const seal=(capture:CarrierCapture)=>{const {capture_sha256:_,...base}=capture;void _;capture.capture_sha256=installHash(base);};
  seal(digest.capture);digest.expected.capture_sha256=digest.capture.capture_sha256;add('C05','digest-substitution',digest.capture,digest.expected,{scope:'REFERENCE_PARSER_ONLY',kind:'INVALID',status:'FAIL',reason_codes:['CARRIER_OUTER_RESULT_DIGEST_INVALID']});
  const foreign=structuredClone(cases[1]!);foreign.capture.comments[0]!.author='untrusted-fixture';seal(foreign.capture);foreign.expected.capture_sha256=foreign.capture.capture_sha256;
  add('C06','foreign-author',foreign.capture,foreign.expected,{scope:'REFERENCE_PARSER_ONLY',kind:'INVALID',status:'FAIL',reason_codes:['CARRIER_COMMENT_AUTHENTICATION_INVALID']});
  const replay=await publish(106,request('artifact-health',healthOp,true));await input.port.duplicate(106);
  if(await input.adapter.admit(await input.port.readIssue(106))!=='CORE')fail();positive('C07','expired-closed-replay',106,replay,new Date().toISOString());
  for(const [number,id,operation] of [[107,'core-case-fresh-expired',healthOp],[108,'artifact-health',fileOp]] as const){
    const req=request(id,operation,true),issue=input.port.register(number,req);
    if(await input.adapter.admit(issue)!=='PUBLICATION_UNAVAILABLE')fail();
    const found=await input.core.status(id,ctx);if(number===107&&found.status!=='NOT_FOUND')fail();
    const capture=input.port.capture(number,input.context_sha256);if(capture.comments.length||capture.issue.state!=='OPEN')fail();
    add('C08',number===107?'fresh-expired':'collision',capture,expected(capture,submission(id,operation)),{scope:'REFERENCE_PARSER_ONLY',kind:'UNAVAILABLE',status:'UNKNOWN',reason_codes:['CARRIER_RESULT_UNAVAILABLE']});
  }
  function invalid(caseId:ProducerCase['case_id'],suffix:string,row:ProducerCase,reason:string){
    seal(row.capture);row.expected.capture_sha256=row.capture.capture_sha256;
    add(caseId,suffix,row.capture,row.expected,{scope:'REFERENCE_PARSER_ONLY',kind:'INVALID',status:'FAIL',reason_codes:[reason]});
  }
  function chunk(row:ProducerCase){
    const comment=row.capture.comments.find(c=>c.body.startsWith('```json\n')&&JSON.parse(c.body.slice(8,-5)).schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1');
    if(!comment)fail('CORE_FIXTURE_LARGE_CHUNK_UNAVAILABLE');
    return {comment,value:JSON.parse(comment.body.slice(8,-5)) as {transferId:string;dataBase64:string;chunkSha256:string;objectSha256:string}};
  }
  const largeMissing=structuredClone(cases[4]!);const missingChunk=chunk(largeMissing).comment;
  largeMissing.capture.comments=largeMissing.capture.comments.filter(c=>c.id!==missingChunk.id);
  invalid('C04','large-missing',largeMissing,'CARRIER_CHUNK_MISSING');
  const largeConflicting=structuredClone(cases[4]!),conflict=chunk(largeConflicting),conflictBytes=Buffer.from(conflict.value.dataBase64,'base64');
  conflictBytes[0]=conflictBytes[0]!^1;conflict.value.dataBase64=conflictBytes.toString('base64');conflict.value.chunkSha256=sha(conflictBytes);
  const conflictId=Math.max(...largeConflicting.capture.comments.map(c=>c.id))+1;
  largeConflicting.capture.comments.push({...conflict.comment,id:conflictId,url:largeConflicting.capture.issue.url+'#issuecomment-'+conflictId,body:fence(conflict.value)});
  invalid('C04','large-conflicting',largeConflicting,'CARRIER_CHUNK_CONFLICT');
  const largeMixed=structuredClone(cases[4]!),mixed=chunk(largeMixed);mixed.value.objectSha256='d'.repeat(64);mixed.value.transferId='result-'+mixed.value.objectSha256;
  const mixedId=Math.max(...largeMixed.capture.comments.map(c=>c.id))+1;
  largeMixed.capture.comments.push({...mixed.comment,id:mixedId,url:largeMixed.capture.issue.url+'#issuecomment-'+mixedId,body:fence(mixed.value)});
  invalid('C04','large-mixed',largeMixed,'CARRIER_ORPHAN_CHUNK');
  const largeCorrupt=structuredClone(cases[4]!),corrupt=chunk(largeCorrupt),corruptBytes=Buffer.from(corrupt.value.dataBase64,'base64');
  corruptBytes[0]=corruptBytes[0]!^1;corrupt.value.dataBase64=corruptBytes.toString('base64');corrupt.comment.body=fence(corrupt.value);
  invalid('C04','large-corrupt',largeCorrupt,'CARRIER_CHUNK_INVALID');
  for(const [suffix,reason,mutate] of [
    ['rehashed-foreign-scope','CARRIER_INPUT_INVALID',(receipt:RBridgeExecutionReceiptV1)=>{receipt.principalId='foreign-fixture-principal';}],
    ['rehashed-foreign-policy','CARRIER_POLICY_BINDING_INVALID',(receipt:RBridgeExecutionReceiptV1)=>{receipt.policy.policySha256='d'.repeat(64);}],
  ] as const){
    const row=structuredClone(cases[0]!),outer=JSON.parse(row.capture.comments[0]!.body.slice(8,-5));
    mutate(outer.operationResult.receipt);outer.resultSha256=sha(JSON.stringify(outer.operationResult));row.capture.comments[0]!.body=fence(outer);
    invalid('C06',suffix,row,reason);
  }
  function sourceResult(suffix:string,row:ProducerCase,outer:Record<string,unknown>,kind:'CORE_RESULT'|'LEGACY_REJECTION'){
    row.capture.comments[0]!.body=fence(outer);seal(row.capture);row.expected.capture_sha256=row.capture.capture_sha256;
    const payload=outer.operationResult as {receipt:RBridgeExecutionReceiptV1}|undefined;
    if(payload)row.expected.receipt_sha256=installHash(payload.receipt);
    else{row.expected.mode='LEGACY';delete row.expected.receipt_sha256;delete row.expected.output_sha256;}
    const bytes=Buffer.from(JSON.stringify(outer)),comment=row.capture.comments[0]!;
    add('C03',suffix,row.capture,row.expected,{scope:'REFERENCE_PARSER_ONLY',status:outer.status,reason_codes:[],envelope:outer,
      evidence:{capture_sha256:row.capture.capture_sha256,context_sha256:row.capture.context_sha256,comment_ids:[comment.id],
        comment_body_sha256:[sha(comment.body)],selected_comment_id:comment.id,envelope_sha256:sha(bytes),raw_envelope_base64:bytes.toString('base64')},
      kind,...(payload?{receipt:payload.receipt}:{})});
  }
  // Fixed Source data exercises receipt parsing; these mutations do not claim
  // that an actual Core operation became uncertain or was physically stopped.
  for(const outcome of ['UNCERTAIN','TERMINATED'] as const){
    const row=structuredClone(cases[2]!),outer=JSON.parse(row.capture.comments[0]!.body.slice(8,-5));
    outer.operationResult.receipt.outcome=outcome;outer.operationResult.receipt.reason='SOURCE_FIXTURE_'+outcome;
    outer.status=outcome==='TERMINATED'?'BLOCKED':outcome;outer.reason=outcome==='TERMINATED'?'RBRIDGE_CORE_TERMINATED':outer.operationResult.receipt.reason;
    outer.resultSha256=sha(JSON.stringify(outer.operationResult));sourceResult(outcome.toLowerCase(),row,outer,'CORE_RESULT');
  }
  for(const status of ['BLOCKED','UNCERTAIN'] as const){
    const row=structuredClone(cases[0]!),outer=JSON.parse(row.capture.comments[0]!.body.slice(8,-5));
    delete outer.operationResult;delete outer.resultSha256;outer.status=status;outer.reason='SOURCE_FIXTURE_LEGACY_'+status;
    sourceResult('legacy-'+status.toLowerCase(),row,outer,'LEGACY_REJECTION');
  }
  const rawExpired=structuredClone(cases[0]!),rawOuter=JSON.parse(rawExpired.capture.comments[0]!.body.slice(8,-5));
  delete rawOuter.operationResult;delete rawOuter.resultSha256;rawOuter.status='BLOCKED';rawOuter.reason='REMOTE_BRIDGE_V2_REQUEST_EXPIRED';
  rawOuter.requestSha256=sha(rawExpired.capture.issue.body);rawExpired.expected.digest_branch='RAW_BODY_PRECLAIM_REJECTION';
  sourceResult('raw-expired-rejection',rawExpired,rawOuter,'LEGACY_REJECTION');
  const requestDigest=structuredClone(cases[0]!),requestOuter=JSON.parse(requestDigest.capture.comments[0]!.body.slice(8,-5));
  requestOuter.requestSha256='d'.repeat(64);requestDigest.capture.comments[0]!.body=fence(requestOuter);
  invalid('C05','request-digest',requestDigest,'CARRIER_REQUEST_DIGEST_INVALID');
  const outputDigest=structuredClone(cases[0]!),outputOuter=JSON.parse(outputDigest.capture.comments[0]!.body.slice(8,-5));
  outputOuter.operationResult.output.uptimeMs++;outputOuter.resultSha256=sha(JSON.stringify(outputOuter.operationResult));outputDigest.capture.comments[0]!.body=fence(outputOuter);
  invalid('C05','output-digest',outputDigest,'CARRIER_OUTPUT_DIGEST_INVALID');
  const foreignRepository=structuredClone(cases[0]!);foreignRepository.capture.repository='foreign-fixture/rbridge-control';
  invalid('C06','foreign-repository',foreignRepository,'CARRIER_AUTHENTICATION_INVALID');
  const foreignIssue=structuredClone(cases[0]!);foreignIssue.capture.issue.number++;
  invalid('C06','foreign-issue',foreignIssue,'CARRIER_AUTHENTICATION_INVALID');
  const foreignRequest=structuredClone(cases[0]!);foreignRequest.capture.issue.title+='-foreign';
  invalid('C06','foreign-request',foreignRequest,'CARRIER_AUTHENTICATION_INVALID');
  await originals();check();
  return {schema:'RBRIDGE_ISOLATED_CORE_CASES_V1' as const,scope:'ISOLATED_CORE_SOURCE_DATA_ONLY' as const,producer_source_sha:SOURCE,binding_sha256:installHash(binding),context_sha256:input.context_sha256,
    original_receipts:input.originals.map(r=>({operation_id:r.operationId,receipt_json:r.receiptJSON,receipt_sha256:r.receiptSHA256,output_sha256:r.resultSHA256})),originals_unchanged:true as const,cases};
}
