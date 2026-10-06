import {createHash} from 'node:crypto';
import {installHash} from '../../src/installation/gateContext.js';
import {remoteBridgeRequestV2Digest,type RemoteBridgeRequestV2} from '../../src/domain/remoteBridgeStage2Protocol.js';
import type {CarrierCapture,ReaderExpectation} from '../../src/installation/rbridge-installation-reader.js';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import {rbridgeOperationIntentDigest,type RBridgeJsonValue,type RBridgeExecutionReceiptV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
export const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
export const source='b5881fd8367b4249e82683f1f884f2392cb696d4',old='008885e07394f20746f034cbd7fe52c6b520533d';
export const fence=(v:unknown)=>'```json\n'+JSON.stringify(v,null,2)+'\n```\n';
export const request:RemoteBridgeRequestV2={schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:'fixture-read',createdAt:'2026-10-05T10:00:00.000Z',expiresAt:'2026-10-05T10:20:00.000Z',operation:{kind:'HEALTH',action:'STATUS'}};
export const health={schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:old,uptimeMs:1,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};
// Synthetic source-format fixtures; actual producer/archive/adoption proof is separate.
export function fixture(value:Record<string,unknown>={operationResult:health,resultSha256:sha(JSON.stringify(health)),status:'PASS'},body=JSON.stringify(request)){
  const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:request.requestId,issueNumber:17,requestSha256:remoteBridgeRequestV2Digest(request),completedAt:'2026-10-05T10:01:00.000Z',...value};
  const base={schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1' as const,scope:'FIXTURE_AUTHORITY_ONLY' as const,context_sha256:'c'.repeat(64),repository:'fixture-owner/fixture',viewer:'fixture-owner',issue:{number:17,title:'[COCWIN BRIDGE REQUEST] fixture-read',body,author:'fixture-owner',url:'https://github.com/fixture-owner/fixture/issues/17',state:'CLOSED' as const,isPullRequest:false as const},comments:[{id:1,author:'fixture-owner',body:fence(envelope),url:'https://github.com/fixture-owner/fixture/issues/17#issuecomment-1'}],complete:true as const};
  const capture:CarrierCapture={...base,capture_sha256:installHash(base)};
  const expected:ReaderExpectation={producer_source_sha:source,mode:'LEGACY',repository:base.repository,author:base.viewer,issue_number:17,request_id:request.requestId,request_title:base.issue.title,request_body_sha256:sha(body),capture_context_sha256:base.context_sha256,capture_sha256:capture.capture_sha256,digest_branch:'ADMITTED_CANONICAL_REQUEST',expected_source_sha:old};
  return {capture,expected,envelope};
}
export function reseal(f:ReturnType<typeof fixture>){const {capture_sha256:_,...base}=f.capture;void _;f.capture.capture_sha256=installHash(base);f.expected.capture_sha256=f.capture.capture_sha256;}
export const canonicalSha=(v:unknown)=>sha(canonicalRBridgeJson(v as RBridgeJsonValue));
export function core(outcome:RBridgeExecutionReceiptV1['outcome']='PASS'){
  const scope={operationId:request.requestId,principalId:'fixture-operator',targetInstanceId:'fixture-host'},submission={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...scope,operation:request.operation},policy=createRBridgeExecutionPolicy({runtimeUid:1027,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId}).evaluate(submission as Parameters<ReturnType<typeof createRBridgeExecutionPolicy>['evaluate']>[0]).snapshot;
  const output={...health,releaseSha:source};
  const receipt:RBridgeExecutionReceiptV1={schema:'RBRIDGE_EXECUTION_RECEIPT_V1',...scope,intentSha256:rbridgeOperationIntentDigest(submission),policy:structuredClone(policy),phase:'TERMINAL',outcome:outcome!,cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL'] as const).map(phase=>({phase,at:'2026-10-05T10:01:00.000Z'})),postconditions:[],...(outcome==='PASS'?{resultSha256:canonicalSha(output)}:{}),...(outcome==='TERMINATED'?{reason:'CONTROLLED_STOP'}:{})};
  const payload={schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt,...(outcome==='PASS'?{output}:{})},f=fixture({status:outcome==='TERMINATED'?'BLOCKED':outcome,operationResult:payload,resultSha256:sha(JSON.stringify(payload)),...(outcome==='TERMINATED'?{reason:'RBRIDGE_CORE_TERMINATED'}:{})});
  f.expected={...f.expected,mode:'CORE',expected_source_sha:source,runtime_uid:1027,scope,intent_sha256:receipt.intentSha256,policy_sha256:policy.policySha256};
  return {...f,receipt,payload,output};
}
export function rewrite(f:ReturnType<typeof fixture>){f.capture.comments[0]!.body=fence(f.envelope);reseal(f);}
export function chunks(f:ReturnType<typeof fixture>){
  const bytes=Buffer.from(JSON.stringify(f.envelope)),objectSha256=sha(bytes),transferId='result-'+objectSha256,count=Math.ceil(bytes.length/40000);let id=0;
  const comment=(body:string)=>({id:++id,author:'fixture-owner',body,url:'https://github.com/fixture-owner/fixture/issues/17#issuecomment-'+id});
  f.capture.comments=Array.from({length:count},(_,index)=>{const part=bytes.subarray(index*40000,(index+1)*40000);return comment(fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:part.toString('base64'),chunkSha256:sha(part),objectSha256}));});
  f.capture.comments.push(comment(fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:bytes.length,objectSha256})));reseal(f);
}
