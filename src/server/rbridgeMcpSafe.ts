import {McpServer,type CallToolResult} from '@modelcontextprotocol/server';
import {z} from 'zod/v4';
import type {RBridgeCoreBinding,RBridgeCorePort} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,RBRIDGE_SAFE_CAPABILITY_KINDS,rbridgeOperationIntentDigest,type RBridgeOperationSubmissionV1,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';

export interface RBridgeMcpBinding{readonly authenticatedSubject:string;readonly principalId:string;readonly targetInstanceId:string;}
export type RBridgeMcpCore=RBridgeCorePort;
export interface RBridgeMcpSafeOptions{binding:RBridgeMcpBinding;core?:RBridgeMcpCore;bindingProvider?:()=>Promise<RBridgeCoreBinding>;}
const ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
// Validate raw argument keys before Zod's record parser strips __proto__.
// Silently changing the intent before hashing/delegation would hide a bad input.
const argsSchema=z.preprocess((value,context)=>{
  try{boundedJson(value);return value;}
  catch{context.addIssue({code:'custom',message:'RBRIDGE_MCP_ARGUMENT_INVALID'});return z.NEVER;}
},z.record(z.string(),z.unknown())).meta({type:'object',additionalProperties:true});
const inputSchema=z.strictObject({
  operationId:z.string().regex(ID_RE),
  operation:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('HEALTH'),action:z.literal('STATUS')}),
    z.strictObject({kind:z.literal('FILE'),action:z.enum(['LIST','STAT','READ','READ_MANY','READ_BINARY','WRITE_TEXT','WRITE_BINARY','APPEND_TEXT','EDIT_EXACT','MOVE','SEARCH']),target:z.string().max(1024),args:argsSchema}),
    z.discriminatedUnion('action',[
      z.strictObject({kind:z.literal('PROCESS'),action:z.literal('START'),args:argsSchema}),
      z.strictObject({kind:z.literal('PROCESS'),action:z.enum(['STATUS','READ_OUTPUT','WRITE_INPUT','TERMINATE']),sessionId:z.string().regex(ID_RE),args:argsSchema}),
    ]),
    z.strictObject({kind:z.literal('CHUNK'),action:z.enum(['PUT','GET','FINALIZE']),transferId:z.string().regex(ID_RE),args:argsSchema}),
  ])
});
function fail(code:string):never{throw new Error(code);}
function response(value:Record<string,unknown>,isError=false):CallToolResult{return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(isError?{isError:true}:{})};}
function boundedJson(value:unknown){try{assertBoundedRBridgeJson(value);}catch(error){fail(error instanceof Error&&error.message==='RBRIDGE_CORE_VALUE_LIMIT'?'RBRIDGE_MCP_ARGUMENT_LIMIT':'RBRIDGE_MCP_ARGUMENT_INVALID');}}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function validateBinding(value:RBridgeMcpBinding):RBridgeMcpBinding{
  if(!value||typeof value.authenticatedSubject!=='string'||typeof value.principalId!=='string'||typeof value.targetInstanceId!=='string'||!/^uid:[1-9][0-9]*$/.test(value.authenticatedSubject)||!Number.isSafeInteger(Number(value.authenticatedSubject.slice(4)))||!ID_RE.test(value.principalId)||!ID_RE.test(value.targetInstanceId))fail('RBRIDGE_MCP_BINDING_INVALID');
  return Object.freeze({authenticatedSubject:value.authenticatedSubject,principalId:value.principalId,targetInstanceId:value.targetInstanceId});
}
export function resolveRBridgeMcpStdioBinding(env:Record<string,string|undefined>,identity:{username:string;uid:number;euid?:number}):RBridgeMcpBinding{
  const runtimeUser=env.RBRIDGE_RUNTIME_USER??'';
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(runtimeUser))fail('RBRIDGE_MCP_RUNTIME_USER_CONFIG_INVALID');
  const euid=identity.euid??identity.uid;
  if(!Number.isSafeInteger(identity.uid)||identity.uid<1||!Number.isSafeInteger(euid)||euid<1||identity.uid!==euid||identity.username!==runtimeUser)fail('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  return validateBinding({authenticatedSubject:`uid:${identity.uid}`,principalId:env.RBRIDGE_MCP_PRINCIPAL_ID??'',targetInstanceId:env.RBRIDGE_INSTANCE_ID??''});
}

export function createRBridgeMcpSafeServer(options:RBridgeMcpSafeOptions):McpServer{
  const binding=validateBinding(options.binding),core=options.core;
  const context:RBridgeTransportContextV1=Object.freeze({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:binding.authenticatedSubject,principalId:binding.principalId});
  const server=new McpServer({name:'rbridge',version:'0.1.0-dev'});
  server.registerTool('rbridge_capabilities',{
    title:'RBridge SAFE capabilities',description:'Discover this transport binding and whether the shared durable execution core is connected.',inputSchema:z.strictObject({}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },async()=>response({schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,supportedKinds:[...RBRIDGE_SAFE_CAPABILITY_KINDS],executionAvailable:core!==undefined,executionStatus:core?'CORE_CONNECTED':'BLOCKED'}));
  server.registerTool('rbridge_submit',{
    title:'Submit a SAFE operation',description:'Submit one transport-neutral operation ID to the shared durable core. Keep the same ID when reconciling; no automatic retry. The P1 entrypoint returns BLOCKED until P2 connects that core.',inputSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },async(input,request)=>{
    let submission:RBridgeOperationSubmissionV1;
    try{boundedJson(input);submission=freeze(parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...input,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId}));}
    catch(error){const reason=error instanceof Error&&/^RBRIDGE_(?:MCP|OPERATION)_[A-Z_]+$/.test(error.message)?error.message:'RBRIDGE_MCP_ARGUMENT_INVALID';return response({schema:'RBRIDGE_MCP_SUBMISSION_RESULT_V1',status:'BLOCKED',reason},true);}
    const scope={schema:'RBRIDGE_MCP_SUBMISSION_RESULT_V1',operationId:submission.operationId,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId};
    if(!core)return response({...scope,status:'BLOCKED',reason:'RBRIDGE_MCP_CORE_NOT_CONFIGURED'},true);
    if(request.mcpReq.signal.aborted)return response({...scope,status:'BLOCKED',reason:'RBRIDGE_MCP_ABORTED_BEFORE_SUBMISSION'},true);
    try{
      const receipt=parseRBridgeExecutionReceipt(await core.submit(submission,context,request.mcpReq.signal),submission,rbridgeOperationIntentDigest(submission));
      return response({...scope,status:'CORE_RECEIPT',receipt},receipt.outcome!==undefined&&receipt.outcome!=='PASS');
    }catch{return response({...scope,status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'},true);}
  });
  return server;
}
