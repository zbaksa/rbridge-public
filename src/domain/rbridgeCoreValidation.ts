import {z} from 'zod/v4';
import {canTransitionRBridgeExecutionPhase,parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeJsonValue,type RBridgeOperationSubmissionV1} from './rbridgeExecutionContract.js';
import {RBRIDGE_CORE_LIMITS as limits,RBRIDGE_ENABLED_ACTIONS,type RBridgeCoreBinding,type RBridgeCoreCancellationResult,type RBridgeCoreLookupResult,type RBridgeCoreResultPage,type RBridgeCoreRpcRequest,type RBridgeCoreRpcResponse,type RBridgeCoreSubmitResult,type RBridgeDeploymentBinding,type RBridgeScope} from './rbridgeCoreProtocol.js';
const ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const id=z.string().regex(ID_RE),hash=z.string().regex(/^[0-9a-f]{64}$/);
const scopeFields={operationId:id,principalId:id,targetInstanceId:id},scopeSchema=z.strictObject(scopeFields);
function fail(code='RBRIDGE_CORE_VALUE_INVALID'):never{throw new Error(code);}
export function assertBoundedRBridgeJson(value:unknown,bounds:{bytes:number;depth:number;nodes:number}={bytes:limits.submissionBytes,depth:limits.depth,nodes:limits.nodes}):void{
  if(!Object.values(bounds).every(v=>Number.isSafeInteger(v)&&v>0))fail();
  const pending=[{value,depth:0}];let nodes=0;
  while(pending.length){
    const item=pending.pop()!;
    if(++nodes>bounds.nodes||item.depth>bounds.depth)fail('RBRIDGE_CORE_VALUE_LIMIT');
    if(item.value===null||typeof item.value==='string'||typeof item.value==='boolean')continue;
    if(typeof item.value==='number'){if(!Number.isFinite(item.value))fail();continue;}
    if(!item.value||typeof item.value!=='object')fail();
    const proto=Object.getPrototypeOf(item.value);
    if(Array.isArray(item.value)){
      if(item.value.length+nodes+pending.length>bounds.nodes)fail('RBRIDGE_CORE_VALUE_LIMIT');
      if(Reflect.ownKeys(item.value).length!==item.value.length+1)fail();
    }else if(proto!==Object.prototype&&proto!==null)fail();
    for(const key of Reflect.ownKeys(item.value)){
      if(Array.isArray(item.value)&&key==='length')continue;
      if(typeof key!=='string'||!key||key.includes('\0')||['__proto__','constructor','prototype'].includes(key))fail();
      const property=Object.getOwnPropertyDescriptor(item.value,key)!;
      if(!property.enumerable||!('value' in property))fail();
      if(nodes+pending.length>=bounds.nodes)fail('RBRIDGE_CORE_VALUE_LIMIT');
      pending.push({value:property.value,depth:item.depth+1});
    }
  }
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>bounds.bytes)fail('RBRIDGE_CORE_VALUE_LIMIT');
}
export function canonicalRBridgeJson(value:RBridgeJsonValue):string{
  assertBoundedRBridgeJson(value,{bytes:limits.outputBytes,depth:limits.depth,nodes:8192});
  function ordered(item:RBridgeJsonValue):RBridgeJsonValue{
    if(Array.isArray(item))return item.map(ordered);
    if(item!==null&&typeof item==='object')return Object.fromEntries(Object.keys(item).sort().map(key=>[key,ordered(item[key]!)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}
function checkScope(value:RBridgeScope,expected:RBridgeScope){scopeSchema.parse({operationId:expected.operationId,principalId:expected.principalId,targetInstanceId:expected.targetInstanceId});if(value.operationId!==expected.operationId||value.principalId!==expected.principalId||value.targetInstanceId!==expected.targetInstanceId)fail();}
const phaseSchema=z.enum(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL']);
const timestampSchema=z.string().refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value);
const receiptSchema=z.strictObject({
  schema:z.literal('RBRIDGE_EXECUTION_RECEIPT_V1'),operationId:z.string().regex(ID_RE),intentSha256:z.string().regex(/^[0-9a-f]{64}$/),principalId:z.string().regex(ID_RE),targetInstanceId:z.string().regex(ID_RE),
  policy:z.strictObject({schema:z.literal('RBRIDGE_POLICY_SNAPSHOT_V1'),mode:z.literal('SAFE'),policyVersion:z.string().min(1).max(128),policySha256:z.string().regex(/^[0-9a-f]{64}$/),decision:z.enum(['ALLOW','BLOCK']),reason:z.string().max(512).optional()}),
  phase:phaseSchema,outcome:z.enum(['PASS','FAIL','BLOCKED','UNCERTAIN','TERMINATED']).optional(),reason:z.string().max(512).optional(),resultSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  cancellation:z.strictObject({state:z.enum(['NONE','REQUESTED','PROCESS_PROVEN_STOPPED','UNSUPPORTED','UNKNOWN']),requestedAt:timestampSchema.optional(),provenStoppedAt:timestampSchema.optional()}),
  sideEffects:z.strictObject({state:z.enum(['NONE_PROVEN','PRESENT','ROLLED_BACK','UNKNOWN'])}),
  transitions:z.array(z.strictObject({phase:phaseSchema,at:timestampSchema})).min(1).max(5),
  postconditions:z.array(z.strictObject({name:z.string().min(1).max(128),status:z.enum(['PASS','FAIL','UNKNOWN']),evidenceSha256:z.string().regex(/^[0-9a-f]{64}$/).optional()})).max(128),
});
export function parseRBridgeExecutionReceipt(value:unknown,submission:RBridgeScope,intentSha256?:string):RBridgeExecutionReceiptV1{
  assertBoundedRBridgeJson(value);const receipt=receiptSchema.parse(value);scopeSchema.parse({operationId:submission.operationId,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId});
  if(receipt.operationId!==submission.operationId||receipt.principalId!==submission.principalId||receipt.targetInstanceId!==submission.targetInstanceId||(intentSha256!==undefined&&receipt.intentSha256!==hash.parse(intentSha256)))fail('RBRIDGE_MCP_RECEIPT_SCOPE_INVALID');
  if(receipt.transitions[0]!.phase!=='CLAIMED'||receipt.transitions.at(-1)!.phase!==receipt.phase)fail('RBRIDGE_MCP_RECEIPT_PHASE_INVALID');
  for(let i=1;i<receipt.transitions.length;i++){
    const previous=receipt.transitions[i-1]!,next=receipt.transitions[i]!;
    if(!canTransitionRBridgeExecutionPhase(previous.phase,next.phase)||Date.parse(next.at)<Date.parse(previous.at))fail('RBRIDGE_MCP_RECEIPT_PHASE_INVALID');
  }
  if((receipt.phase==='TERMINAL')!==(receipt.outcome!==undefined)||(receipt.outcome==='PASS'&&receipt.policy.decision!=='ALLOW'))fail('RBRIDGE_MCP_RECEIPT_PHASE_INVALID');
  if(receipt.phase==='TERMINAL'&&receipt.transitions.length===2&&(receipt.outcome!=='BLOCKED'||receipt.policy.decision!=='BLOCK'||receipt.sideEffects.state!=='NONE_PROVEN'))fail('RBRIDGE_MCP_RECEIPT_PHASE_INVALID');
  if(receipt.outcome==='PASS'&&receipt.postconditions.some(item=>item.status!=='PASS'))fail('RBRIDGE_MCP_RECEIPT_POSTCONDITION_INVALID');
  if(receipt.cancellation.state==='PROCESS_PROVEN_STOPPED'&&!receipt.cancellation.provenStoppedAt)fail('RBRIDGE_MCP_RECEIPT_CANCEL_INVALID');
  // Receipts cross a JSON boundary; remove absent optional fields rather than
  // exposing Zod's possible explicit undefined values to the frozen contract.
  return JSON.parse(JSON.stringify(receipt)) as RBridgeExecutionReceiptV1;
}

const submitSchema=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('RECEIPT'),receipt:z.unknown()}),
  z.strictObject({status:z.literal('REJECTED'),reason:z.enum(['RBRIDGE_CORE_INTENT_COLLISION','RBRIDGE_CORE_SCOPE_INVALID','RBRIDGE_CORE_LEGACY_ID_RESERVED','RBRIDGE_CORE_CAPACITY_REACHED']),...scopeFields}),
]);
export function parseRBridgeCoreSubmitResult(value:unknown,submission:RBridgeOperationSubmissionV1):RBridgeCoreSubmitResult{
  assertBoundedRBridgeJson(value);const result=submitSchema.parse(value);
  if(result.status==='RECEIPT')return {status:'RECEIPT',receipt:parseRBridgeExecutionReceipt(result.receipt,submission,rbridgeOperationIntentDigest(submission))};
  checkScope(result,submission);return result;
}
const lookupSchema=z.discriminatedUnion('status',[z.strictObject({status:z.literal('RECEIPT'),receipt:z.unknown()}),z.strictObject({status:z.literal('NOT_FOUND'),...scopeFields})]);
export function parseRBridgeCoreLookupResult(value:unknown,scope:RBridgeScope):RBridgeCoreLookupResult{
  assertBoundedRBridgeJson(value);const result=lookupSchema.parse(value);
  if(result.status==='RECEIPT')return {status:'RECEIPT',receipt:parseRBridgeExecutionReceipt(result.receipt,scope)};
  checkScope(result,scope);return result;
}
export function assertRBridgeResultRange(cursor:number,maxBytes:number):void{
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>limits.outputBytes||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>limits.pageBytes)fail();
}
const pageSchema=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('RESULT'),receipt:z.unknown(),resultSha256:hash,cursor:z.number(),nextCursor:z.number(),eof:z.boolean(),dataBase64:z.string()}),
  z.strictObject({status:z.literal('NOT_READY'),receipt:z.unknown()}),z.strictObject({status:z.literal('NOT_FOUND'),...scopeFields}),
]);
export function parseRBridgeCoreResultPage(value:unknown,scope:RBridgeScope,cursor:number,maxBytes:number):RBridgeCoreResultPage{
  assertRBridgeResultRange(cursor,maxBytes);assertBoundedRBridgeJson(value,{bytes:limits.responseBytes,depth:limits.depth,nodes:limits.nodes});const result=pageSchema.parse(value);
  if(result.status==='NOT_FOUND'){checkScope(result,scope);return result;}
  const receipt=parseRBridgeExecutionReceipt(result.receipt,scope);
  if(result.status==='NOT_READY'){if(receipt.resultSha256!==undefined)fail();return {status:'NOT_READY',receipt};}
  if(receipt.phase!=='TERMINAL'||receipt.resultSha256!==result.resultSha256||result.cursor!==cursor||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.dataBase64))fail();
  const bytes=Buffer.from(result.dataBase64,'base64');
  if(bytes.toString('base64')!==result.dataBase64||bytes.length>maxBytes||result.nextCursor!==cursor+bytes.length||result.nextCursor>limits.outputBytes||(!result.eof&&bytes.length===0))fail();
  return {...result,receipt};
}
const cancelSchema=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('REQUESTED'),receipt:z.unknown()}),z.strictObject({status:z.literal('UNCHANGED_TERMINAL'),receipt:z.unknown()}),
  z.strictObject({status:z.literal('NOT_FOUND'),...scopeFields}),z.strictObject({status:z.literal('REJECTED'),reason:z.enum(['RBRIDGE_CORE_SCOPE_INVALID','RBRIDGE_CORE_INTENT_COLLISION']),...scopeFields}),
]);
export function parseRBridgeCoreCancellationResult(value:unknown,scope:RBridgeScope,intentSha256:string):RBridgeCoreCancellationResult{
  hash.parse(intentSha256);assertBoundedRBridgeJson(value);const result=cancelSchema.parse(value);
  if(result.status==='NOT_FOUND'||result.status==='REJECTED'){checkScope(result,scope);return result;}
  const receipt=parseRBridgeExecutionReceipt(result.receipt,scope,intentSha256);
  if(result.status==='UNCHANGED_TERMINAL'){if(receipt.phase!=='TERMINAL')fail();}
  else if(receipt.phase==='TERMINAL'||receipt.cancellation.state!=='REQUESTED'||!receipt.cancellation.requestedAt)fail();
  return {status:result.status,receipt};
}
const bindingSchema=z.strictObject({schema:z.literal('RBRIDGE_CORE_BINDING_V1'),journalSchema:z.literal('RBRIDGE_EXECUTION_JOURNAL_V1'),runtimeUid:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),principalId:id,targetInstanceId:id,policySha256:hash,enabledActions:z.array(z.enum(RBRIDGE_ENABLED_ACTIONS)).max(7).refine(rows=>new Set(rows).size===rows.length)});
export function parseRBridgeCoreBinding(value:unknown):RBridgeCoreBinding{assertBoundedRBridgeJson(value);return bindingSchema.parse(value);}
export function parseRBridgeDeploymentBinding(value:unknown):RBridgeDeploymentBinding{assertBoundedRBridgeJson(value);return z.strictObject({runtimeUid:bindingSchema.shape.runtimeUid,principalId:id,targetInstanceId:id}).parse(value);}
const rpcSchema=z.discriminatedUnion('action',[
  z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_V1'),action:z.literal('BINDING')}),
  z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_V1'),action:z.literal('SUBMIT'),submission:z.unknown()}),
  z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_V1'),action:z.literal('STATUS'),operationId:id}),
  z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_V1'),action:z.literal('RESULT'),operationId:id,cursor:z.number(),maxBytes:z.number()}),
  z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_V1'),action:z.literal('CANCEL_INTENT'),operationId:id,intentSha256:hash}),
]);
export function parseRBridgeCoreRpcRequest(value:unknown):RBridgeCoreRpcRequest{
  assertBoundedRBridgeJson(value);if(Buffer.byteLength(JSON.stringify(value))+1>limits.requestBytes)fail('RBRIDGE_CORE_RPC_LIMIT');const request=rpcSchema.parse(value);
  if(request.action==='SUBMIT')return {...request,submission:parseRBridgeOperationSubmissionV1(request.submission)};
  if(request.action==='RESULT')assertRBridgeResultRange(request.cursor,request.maxBytes);
  return request;
}
export function parseRBridgeCoreRpcResponse(value:unknown,request:RBridgeCoreRpcRequest,binding:RBridgeDeploymentBinding):RBridgeCoreRpcResponse{
  assertBoundedRBridgeJson(value,{bytes:limits.responseBytes,depth:limits.depth,nodes:limits.nodes});if(Buffer.byteLength(JSON.stringify(value))+1>limits.responseBytes)fail();
  const result=z.discriminatedUnion('schema',[
    z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_ERROR_V1'),reason:z.enum(['RBRIDGE_CORE_RPC_INVALID','RBRIDGE_CORE_RPC_LIMIT','RBRIDGE_CORE_RPC_UNAVAILABLE'])}),
    z.strictObject({schema:z.literal('RBRIDGE_CORE_RPC_RESULT_V1'),action:z.enum(['BINDING','SUBMIT','STATUS','RESULT','CANCEL_INTENT']),value:z.unknown()}),
  ]).parse(value);
  if(result.schema==='RBRIDGE_CORE_RPC_ERROR_V1')return result;
  if(result.action!==request.action)fail();
  const scope=request.action==='BINDING'?undefined:{operationId:request.action==='SUBMIT'?request.submission.operationId:request.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};
  switch(request.action){
    case 'BINDING':return {...result,value:parseRBridgeCoreBinding(result.value)};
    case 'SUBMIT':return {...result,value:parseRBridgeCoreSubmitResult(result.value,request.submission)};
    case 'STATUS':return {...result,value:parseRBridgeCoreLookupResult(result.value,scope!)};
    case 'RESULT':return {...result,value:parseRBridgeCoreResultPage(result.value,scope!,request.cursor,request.maxBytes)};
    case 'CANCEL_INTENT':return {...result,value:parseRBridgeCoreCancellationResult(result.value,scope!,request.intentSha256)};
  }
}
