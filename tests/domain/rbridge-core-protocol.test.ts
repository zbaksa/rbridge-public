import {describe,expect,it} from 'vitest';
import {rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson,parseRBridgeCoreBinding,parseRBridgeCoreCancellationResult,parseRBridgeCoreLookupResult,parseRBridgeCoreResultPage,parseRBridgeCoreRpcRequest,parseRBridgeCoreRpcResponse,parseRBridgeCoreSubmitResult} from '../../src/domain/rbridgeCoreValidation.js';

const submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'health-1',principalId:'operator',targetInstanceId:'aether',operation:{kind:'HEALTH',action:'STATUS'}};
const scope={operationId:submission.operationId,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId};
const binding={schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',runtimeUid:1027,principalId:'operator',targetInstanceId:'aether',policySha256:'a'.repeat(64),enabledActions:['HEALTH/STATUS']} as const;
function receipt():RBridgeExecutionReceiptV1{return {schema:'RBRIDGE_EXECUTION_RECEIPT_V1',...scope,intentSha256:rbridgeOperationIntentDigest(submission),policy:{schema:'RBRIDGE_POLICY_SNAPSHOT_V1',mode:'SAFE',policyVersion:'another-policy',policySha256:'a'.repeat(64),decision:'ALLOW'},phase:'TERMINAL',outcome:'PASS',resultSha256:'b'.repeat(64),cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL'].map(phase=>({phase:phase as RBridgeExecutionReceiptV1['phase'],at:'2026-10-05T00:00:00.000Z'})),postconditions:[]};}

describe('bounded shared core protocol',()=>{
  it('rejects caller provenance and unsafe nested JSON before parsing',()=>{
    expect(()=>parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',action:'BINDING',transport:'GITHUB'})).toThrow();
    for(const value of [JSON.parse('{"x":{"constructor":1}}'),JSON.parse('{"x":{"__proto__":1}}'),{x:Infinity},{x:undefined},new Date(),{get x(){throw new Error('getter must not run');}}])expect(()=>assertBoundedRBridgeJson(value)).toThrow();
    const cyclic:Record<string,unknown>={};cyclic.x=cyclic;expect(()=>assertBoundedRBridgeJson(cyclic)).toThrow();
    expect(()=>assertBoundedRBridgeJson({x:'a'.repeat(65528)})).not.toThrow();
    expect(()=>assertBoundedRBridgeJson({x:'a'.repeat(65529)})).toThrow();
    expect(()=>assertBoundedRBridgeJson(Array(4096).fill(0))).toThrow();
    let deep:unknown=0;for(let n=0;n<17;n++)deep={x:deep};expect(()=>assertBoundedRBridgeJson(deep)).toThrow();
  });
  it('canonicalizes independently ordered JSON and permits a bounded large output',()=>{
    expect(canonicalRBridgeJson({z:1,a:{y:2,b:3}})).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(()=>assertBoundedRBridgeJson({text:'a'.repeat(1048576)},{bytes:8388608,depth:16,nodes:4096})).not.toThrow();
    expect(()=>assertBoundedRBridgeJson({text:'a'.repeat(1048576)})).toThrow();
  });
  it('validates scoped discriminated responses without inventing P2 postconditions',()=>{
    const good={status:'RECEIPT',receipt:receipt()};
    expect(parseRBridgeCoreSubmitResult(good,submission)).toEqual(good);
    expect(parseRBridgeCoreLookupResult(good,scope)).toEqual(good);
    for(const field of ['operationId','principalId','targetInstanceId','intentSha256'] as const)expect(()=>parseRBridgeCoreSubmitResult({status:'RECEIPT',receipt:{...receipt(),[field]:field==='intentSha256'?'c'.repeat(64):'other'}},submission)).toThrow();
    expect(()=>parseRBridgeCoreSubmitResult({...good,extra:1},submission)).toThrow();
    expect(()=>parseRBridgeCoreLookupResult({status:'NOT_FOUND',...scope,principalId:'foreign'},scope)).toThrow();
    expect(parseRBridgeCoreSubmitResult({status:'REJECTED',reason:'RBRIDGE_CORE_CAPACITY_REACHED',...scope},submission).status).toBe('REJECTED');
    expect(()=>parseRBridgeCoreSubmitResult({status:'REJECTED',reason:'made-up',...scope},submission)).toThrow();
  });
  it('rejects impossible receipt history, failed PASS proofs and unproved process stops',()=>{
    for(const changes of [
      {transitions:[{phase:'CLAIMED',at:'2026-10-05T00:00:00.000Z'},{phase:'TERMINAL',at:'2026-10-05T00:00:00.000Z'}]},
      {postconditions:[{name:'read',status:'UNKNOWN'}]},
      {cancellation:{state:'PROCESS_PROVEN_STOPPED'}},
      {policy:{...receipt().policy,decision:'BLOCK'}},
    ])expect(()=>parseRBridgeCoreLookupResult({status:'RECEIPT',receipt:{...receipt(),...changes}},scope)).toThrow();
  });
  it('checks canonical base64, cursor progress and page size',()=>{
    const page={status:'RESULT',receipt:receipt(),resultSha256:'b'.repeat(64),cursor:0,nextCursor:3,eof:true,dataBase64:'YWJj'};
    expect(parseRBridgeCoreResultPage(page,scope,0,3)).toEqual(page);
    for(const changes of [{dataBase64:'YR=='},{nextCursor:4},{cursor:1},{dataBase64:'YWJj\n'},{eof:false,dataBase64:'',nextCursor:0},{resultSha256:'c'.repeat(64)}])expect(()=>parseRBridgeCoreResultPage({...page,...changes},scope,0,3)).toThrow();
    expect(()=>parseRBridgeCoreResultPage(page,scope,0,2)).toThrow();
    expect(()=>parseRBridgeCoreResultPage(page,scope,Number.MAX_SAFE_INTEGER+1,3)).toThrow();
    expect(()=>parseRBridgeCoreResultPage({status:'NOT_READY',receipt:receipt()},scope,0,3)).toThrow();
  });
  it('requires acknowledged cancellation to be durable and bound to the intent',()=>{
    const pending={...receipt(),phase:'AUTHORIZED' as const,transitions:receipt().transitions.slice(0,2),cancellation:{state:'REQUESTED' as const,requestedAt:'2026-10-05T00:00:00.000Z'}};delete pending.outcome;delete pending.resultSha256;
    expect(parseRBridgeCoreCancellationResult({status:'REQUESTED',receipt:pending},scope,rbridgeOperationIntentDigest(submission)).status).toBe('REQUESTED');
    expect(()=>parseRBridgeCoreCancellationResult({status:'REQUESTED',receipt:{...pending,cancellation:{state:'NONE'}}},scope,rbridgeOperationIntentDigest(submission))).toThrow();
    expect(()=>parseRBridgeCoreCancellationResult({status:'UNCHANGED_TERMINAL',receipt:receipt()},scope,'c'.repeat(64))).toThrow();
  });
  it('matches RPC response actions to their exact result union',()=>{
    const request={schema:'RBRIDGE_CORE_RPC_V1',action:'BINDING'} as const;
    expect(parseRBridgeCoreRpcResponse({schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:'BINDING',value:binding},request,binding)).toHaveProperty('action','BINDING');
    expect(()=>parseRBridgeCoreRpcResponse({schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:'STATUS',value:binding},request,binding)).toThrow();
    expect(()=>parseRBridgeCoreRpcResponse({schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:'BINDING',value:{status:'RECEIPT',receipt:receipt()}},request,binding)).toThrow();
    expect(()=>parseRBridgeCoreBinding({...binding,runtimeUid:0})).toThrow();
    expect(()=>parseRBridgeCoreBinding({...binding,enabledActions:['FILE/WRITE_TEXT']})).toThrow();
    expect(()=>parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',action:'RESULT',operationId:'health-1',cursor:-1,maxBytes:1})).toThrow();
    expect(()=>parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',action:'RESULT',operationId:'health-1',cursor:0,maxBytes:32769})).toThrow();
    expect(parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',action:'RESULT',operationId:'health-1',cursor:0,maxBytes:32768})).toHaveProperty('maxBytes',32768);
  });
});
