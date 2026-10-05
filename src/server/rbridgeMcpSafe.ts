import {McpServer,type CallToolResult} from '@modelcontextprotocol/server';
import {z} from 'zod/v4';
import {RBRIDGE_CORE_LIMITS as limits,type RBridgeCoreBinding,type RBridgeCoreCancellationResult,type RBridgeCoreLookupResult,type RBridgeCorePort,type RBridgeCoreResultPage,type RBridgeScope} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,parseRBridgeCoreBinding,parseRBridgeCoreCancellationResult,parseRBridgeCoreLookupResult,parseRBridgeCoreResultPage,parseRBridgeCoreSubmitResult} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,RBRIDGE_SAFE_CAPABILITY_KINDS,type RBridgeOperationSubmissionV1,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';

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
  const binding=validateBinding(options.binding),core=options.core,bindingProvider=options.bindingProvider;
  const context:RBridgeTransportContextV1=Object.freeze({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:binding.authenticatedSubject,principalId:binding.principalId});
  const server=new McpServer({name:'rbridge',version:'0.1.0-dev'});
  const scope=(operationId:string):RBridgeScope=>({operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId});
  async function connection(){
    if(!core)return {connected:false as const,reason:'RBRIDGE_MCP_CORE_NOT_CONFIGURED'};
    try{
      const owner=bindingProvider?parseRBridgeCoreBinding(await bindingProvider()):undefined;
      if(owner&&(binding.authenticatedSubject!==`uid:${owner.runtimeUid}`||owner.principalId!==binding.principalId||owner.targetInstanceId!==binding.targetInstanceId))fail('RBRIDGE_MCP_BINDING_INVALID');
      return {connected:true as const,owner};
    }catch{return {connected:false as const,reason:'RBRIDGE_MCP_CORE_UNAVAILABLE'};}
  }
  async function query(tool:string,operationId:string,signal:AbortSignal,invoke:(expected:RBridgeScope)=>Promise<RBridgeCoreLookupResult|RBridgeCoreResultPage|RBridgeCoreCancellationResult>){
    const expected=scope(operationId),base={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool,...expected};
    if(signal.aborted)return response({...base,status:'BLOCKED',reason:'RBRIDGE_MCP_ABORTED_BEFORE_QUERY'},true);
    const connected=await connection();if(!connected.connected)return response({...base,status:'BLOCKED',reason:connected.reason},true);
    if(signal.aborted)return response({...base,status:'BLOCKED',reason:'RBRIDGE_MCP_ABORTED_BEFORE_QUERY'},true);
    try{const result=await invoke(expected);return response({schema:base.schema,tool,result},result.status==='REJECTED');}
    catch{return response({...base,status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'},true);}
  }
  server.registerTool('rbridge_capabilities',{
    title:'RBridge SAFE capabilities',description:'Discover the current owner connection, enabled actions and policy.',inputSchema:z.strictObject({}),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },async()=>{
    const connected=await connection(),owner=connected.connected?connected.owner:undefined;
    return response({schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,supportedKinds:[...RBRIDGE_SAFE_CAPABILITY_KINDS],enabledActions:owner?[...owner.enabledActions]:[],...(owner?{policySha256:owner.policySha256}:{}),executionAvailable:connected.connected,executionStatus:connected.connected?'CORE_CONNECTED':'BLOCKED',...(!connected.connected?{reason:connected.reason}:{})});
  });
  server.registerTool('rbridge_submit',{
    title:'Submit a SAFE operation',description:'Submit an operation to the durable owner. Keep the same operation ID when reconciling an uncertain acknowledgement.',inputSchema,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },async(input,request)=>{
    let submission:RBridgeOperationSubmissionV1;
    try{boundedJson(input);submission=freeze(parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...input,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId}));}
    catch(error){const reason=error instanceof Error&&/^RBRIDGE_(?:MCP|OPERATION)_[A-Z_]+$/.test(error.message)?error.message:'RBRIDGE_MCP_ARGUMENT_INVALID';return response({schema:'RBRIDGE_MCP_SUBMISSION_RESULT_V1',status:'BLOCKED',reason},true);}
    const scope={schema:'RBRIDGE_MCP_SUBMISSION_RESULT_V1',operationId:submission.operationId,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId};
    if(!core)return response({...scope,status:'BLOCKED',reason:'RBRIDGE_MCP_CORE_NOT_CONFIGURED'},true);
    if(request.mcpReq.signal.aborted)return response({...scope,status:'BLOCKED',reason:'RBRIDGE_MCP_ABORTED_BEFORE_SUBMISSION'},true);
    const connected=await connection();if(!connected.connected)return response({...scope,status:'BLOCKED',reason:connected.reason},true);
    if(request.mcpReq.signal.aborted)return response({...scope,status:'BLOCKED',reason:'RBRIDGE_MCP_ABORTED_BEFORE_SUBMISSION'},true);
    try{
      const result=parseRBridgeCoreSubmitResult(await core.submit(submission,context,request.mcpReq.signal),submission);
      if(result.status==='REJECTED')return response({...scope,status:'BLOCKED',reason:result.reason},true);
      const receipt=result.receipt;
      return response({...scope,status:'CORE_RECEIPT',receipt},receipt.outcome!==undefined&&receipt.outcome!=='PASS');
    }catch{return response({...scope,status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'},true);}
  });
  server.registerTool('rbridge_status',{
    title:'Read operation status',description:'Read the existing durable receipt for an operation ID.',inputSchema:z.strictObject({operationId:z.string().regex(ID_RE)}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async(input,request)=>query('rbridge_status',input.operationId,request.mcpReq.signal,async expected=>parseRBridgeCoreLookupResult(await core!.status(input.operationId,context),expected)));
  server.registerTool('rbridge_result',{
    title:'Read an output page',description:'Read a bounded output page and its whole-result SHA256.',inputSchema:z.strictObject({operationId:z.string().regex(ID_RE),cursor:z.number().int().min(0).max(limits.outputBytes),maxBytes:z.number().int().min(1).max(limits.pageBytes)}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async(input,request)=>query('rbridge_result',input.operationId,request.mcpReq.signal,async expected=>parseRBridgeCoreResultPage(await core!.result(input.operationId,input.cursor,input.maxBytes,context),expected,input.cursor,input.maxBytes)));
  server.registerTool('rbridge_cancel',{
    title:'Request cancellation',description:'Record cancellation intent for the original operation digest. Acknowledgement of intent does not prove completion.',inputSchema:z.strictObject({operationId:z.string().regex(ID_RE),intentSha256:z.string().regex(/^[0-9a-f]{64}$/)}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async(input,request)=>query('rbridge_cancel',input.operationId,request.mcpReq.signal,async expected=>parseRBridgeCoreCancellationResult(await core!.requestCancel(input.operationId,input.intentSha256,context),expected,input.intentSha256)));
  return server;
}
