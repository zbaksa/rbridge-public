/** Complete fixture byte preimages; this predicate grants no execution authority. */
import {createHash} from 'node:crypto';
import {RBRIDGE_CORE_LIMITS} from '../domain/rbridgeCoreProtocol.js';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeTransportContextV1,type RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson,parseRBridgeExecutionReceipt,parseRBridgeCoreResultPage} from '../domain/rbridgeCoreValidation.js';
import {encodeInstallReport} from './types.js';
import {parseStrictJson} from './strictJson.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>Buffer.from(encodeInstallReport(value)).toString('utf8');
function fail():never{throw new Error('ARTIFACT_FIXTURE_PREIMAGE_INVALID');}

export function captureArtifactOperation(input:{submission:unknown;context:RBridgeTransportContextV1;
  receipt:unknown;pages:readonly unknown[];output:Uint8Array;policy_sha256:string}){
  const submission=parseRBridgeOperationSubmissionV1(input.submission),context=input.context;
  assertBoundedRBridgeJson(context);
  if(Object.keys(context).sort().join(',')!=='authenticatedSubject,principalId,schema,transport'
    ||context.schema!=='RBRIDGE_TRANSPORT_CONTEXT_V1'||context.transport!=='MCP'
    ||!/^uid:[1-9][0-9]*$/.test(context.authenticatedSubject)||context.principalId!==submission.principalId
    ||!((submission.operationId==='artifact-health'&&submission.operation.kind==='HEALTH'&&submission.operation.action==='STATUS')
      ||(submission.operationId==='artifact-read'&&submission.operation.kind==='FILE'&&submission.operation.action==='READ'))
    ||!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>512
    ||!(input.output instanceof Uint8Array)||!input.output.length||input.output.length>RBRIDGE_CORE_LIMITS.outputBytes
    ||! /^[0-9a-f]{64}$/.test(input.policy_sha256))fail();
  const receipt=parseRBridgeExecutionReceipt(input.receipt,submission,rbridgeOperationIntentDigest(submission));
  if(receipt.phase!=='TERMINAL'||receipt.outcome!=='PASS'||receipt.policy.policySha256!==input.policy_sha256
    ||receipt.resultSha256!==hash(input.output))fail();
  const receiptJSON=json(receipt),receiptSHA256=hash(receiptJSON),parts:Buffer[]=[],pagesJSON:string[]=[];
  let cursor=0;
  for(let i=0;i<input.pages.length;i++){
    const page=parseRBridgeCoreResultPage(input.pages[i],submission,cursor,32768);
    if(page.status!=='RESULT'||hash(json(page.receipt))!==receiptSHA256
      ||page.resultSha256!==receipt.resultSha256||page.eof!==(i===input.pages.length-1))fail();
    parts.push(Buffer.from(page.dataBase64,'base64'));cursor=page.nextCursor;pagesJSON.push(json(page));
  }
  const bytes=Buffer.concat(parts);
  if(cursor!==input.output.length||!bytes.equals(Buffer.from(input.output)))fail();
  const resultJSON=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(canonicalRBridgeJson(parseStrictJson(resultJSON) as RBridgeJsonValue)!==resultJSON)fail();
  return {scope:'FINAL_ARTIFACT_OPERATION_BYTES_ONLY' as const,operationId:submission.operationId,
    submissionJSON:json(submission),contextJSON:json(context),receiptJSON,receiptSHA256,pagesJSON,
    resultJSON,resultBase64:bytes.toString('base64'),resultBytes:bytes.length,resultSHA256:receipt.resultSha256};
}
