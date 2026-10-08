/** Fixed Source recipes. No recipe authenticates an execution or a client. */
import {createHash} from 'node:crypto';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {canonicalRBridgeJson,parseRBridgeDeploymentBinding,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import {rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1} from '../domain/rbridgeExecutionContract.js';
import {installHash} from './gateContext.js';
import type {McpReadClient,McpReaderScope} from './rbridge-installation-client.js';

export const MCP_NEGATIVE_VARIANTS=['not-found','not-ready','terminal','unavailable','binding','schema','cursor','digest','utf8','json','canonical'] as const;
export type McpNegativeVariant=typeof MCP_NEGATIVE_VARIANTS[number];
export interface McpFixtureQuery{name:Parameters<McpReadClient['callTool']>[0]['name'];arguments:Record<string,unknown>;row:Record<string,unknown>;isError?:true;}
export function mcpFixtureCapabilities(binding:RBridgeDeploymentBinding,policy:string){return {schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,
  supportedKinds:['HEALTH','FILE','PROCESS','CHUNK'],enabledActions:[...RBRIDGE_ENABLED_ACTIONS],policySha256:policy,executionAvailable:true,executionStatus:'CORE_CONNECTED'};}
export function createMcpNegativeCases(rawBinding:RBridgeDeploymentBinding,policy:string,original:RBridgeExecutionReceiptV1,deadline_ms:number){
  const binding=parseRBridgeDeploymentBinding(rawBinding),scope={operationId:'artifact-health',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};
  const intent=rbridgeOperationIntentDigest({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...scope,operation:{kind:'HEALTH',action:'STATUS'}});
  const originalReceipt=parseRBridgeExecutionReceipt(original,scope,intent);
  if(!/^[0-9a-f]{64}$/.test(policy)||originalReceipt.policy.policySha256!==policy||originalReceipt.policy.decision!=='ALLOW'
    ||originalReceipt.phase!=='TERMINAL'||originalReceipt.outcome!=='PASS'||!originalReceipt.resultSha256
    ||!Number.isSafeInteger(deadline_ms)||deadline_ms<1||deadline_ms>180000)throw new Error('MCP_FIXTURE_RECIPE_INVALID');
  return MCP_NEGATIVE_VARIANTS.map(variant=>{
    const operationId='artifact-mcp-'+variant,expected:McpReaderScope={operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,
      runtime_uid:binding.runtimeUid,intent_sha256:intent,policy_sha256:policy,deadline_ms};
    const base={scope:'REFERENCE_MCP_READ'},queries:McpFixtureQuery[]=[{name:'rbridge_capabilities',arguments:{},row:mcpFixtureCapabilities(binding,policy)}];
    const statusArgs={operationId},core=(tool:string,result:unknown)=>({schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool,result});
    if(variant==='not-found'){
      queries.push({name:'rbridge_status',arguments:statusArgs,row:core('rbridge_status',{status:'NOT_FOUND',operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId})});
      return {variant,expected,queries,verdict:{...base,status:'NOT_FOUND',reason_codes:[]}};
    }
    if(variant==='unavailable'){
      queries.push({name:'rbridge_status',arguments:statusArgs,isError:true,row:{schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:'rbridge_status',operationId,
        principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_UNAVAILABLE'}});
      return {variant,expected,queries,verdict:{...base,status:'UNAVAILABLE',reason_codes:['MCP_READER_QUERY_UNAVAILABLE']}};
    }
    let bytes=Buffer.from(canonicalRBridgeJson({fixture:'reader-negative',text:'é🙂'}));
    if(variant==='utf8')bytes=Buffer.from([0xc3,0x28]);
    if(variant==='json')bytes=Buffer.from('{');
    if(variant==='canonical')bytes=Buffer.from('{ "fixture": "reader-negative", "text": "é🙂" }');
    const receipt=structuredClone(originalReceipt);receipt.operationId=operationId;receipt.intentSha256=intent;
    delete receipt.reason;receipt.resultSha256=variant==='digest'?'d'.repeat(64):createHash('sha256').update(bytes).digest('hex');
    if(variant==='not-ready'){
      receipt.phase='RUNNING';delete receipt.outcome;delete receipt.resultSha256;
      receipt.transitions=receipt.transitions.filter(row=>row.phase!=='TERMINAL');
    }
    if(variant==='terminal'){receipt.outcome='FAIL';receipt.reason='SOURCE_FIXTURE_TERMINAL_NO_OUTPUT';delete receipt.resultSha256;}
    const parsed=parseRBridgeExecutionReceipt(receipt,expected,intent);expected.receipt_sha256=installHash(parsed);
    if(parsed.resultSha256)expected.output_sha256=parsed.resultSha256;
    const status=core(variant==='binding'?'rbridge_result':'rbridge_status',{status:'RECEIPT',receipt:parsed});
    if(variant==='schema')status.schema='SOURCE_FIXTURE_WRONG_SCHEMA';
    queries.push({name:'rbridge_status',arguments:statusArgs,row:status});
    if(variant==='not-ready'||variant==='terminal')return {variant,expected,queries,verdict:{...base,status:variant==='not-ready'?'NOT_READY':'TERMINAL',reason_codes:[],receipt:parsed}};
    const reason=variant==='binding'?'MCP_READER_BINDING_INVALID':variant==='schema'?'MCP_READER_SCHEMA_INVALID'
      :variant==='cursor'?'MCP_READER_PAGE_INVALID':variant==='digest'?'MCP_READER_WHOLE_DIGEST_INVALID'
        :variant==='utf8'?'MCP_READER_UTF8_INVALID':variant==='json'?'MCP_READER_JSON_INVALID':'MCP_READER_CANONICAL_OUTPUT_INVALID';
    if(!['binding','schema'].includes(variant))queries.push({name:'rbridge_result',arguments:{operationId,cursor:0,maxBytes:32768},row:core('rbridge_result',{
      status:'RESULT',receipt:parsed,resultSha256:parsed.resultSha256,cursor:0,nextCursor:bytes.length+(variant==='cursor'?1:0),eof:true,dataBase64:bytes.toString('base64')})});
    return {variant,expected,queries,verdict:{...base,status:'INVALID',reason_codes:[reason]}};
  });
}
