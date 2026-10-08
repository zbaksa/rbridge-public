/** Read-only official-SDK Source fixture in the protected toolkit. */
import {McpServer,type CallToolResult} from '@modelcontextprotocol/server';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod/v4';
import {lstat,readdir} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {parseRBridgeDeploymentBinding,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeExecutionReceiptV1} from '../domain/rbridgeExecutionContract.js';
import {createMcpNegativeCases,mcpFixtureCapabilities,MCP_NEGATIVE_VARIANTS} from './mcpNegativeCases.js';

function fail():never{throw new Error('MCP_NEGATIVE_FIXTURE_INVALID');}
export function createMcpNegativeFixtureServer(binding:RBridgeDeploymentBinding,policy:string,original:RBridgeExecutionReceiptV1){
  const recipes=createMcpNegativeCases(binding,policy,original,15000),server=new McpServer({name:'rbridge',version:'0.1.0-dev'});
  const reply=(row:Record<string,unknown>,isError=false):CallToolResult=>({content:[{type:'text',text:JSON.stringify(row)}],structuredContent:structuredClone(row),...(isError?{isError:true}:{})});
  const id=z.enum(['artifact-health',...MCP_NEGATIVE_VARIANTS.map(v=>'artifact-mcp-'+v)]);
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  server.registerTool('rbridge_capabilities',{description:'Fixed Source fixture capabilities.',inputSchema:z.strictObject({}),annotations},async()=>reply(mcpFixtureCapabilities(binding,policy)));
  server.registerTool('rbridge_status',{description:'Read a fixed Source fixture status.',inputSchema:z.strictObject({operationId:id}),annotations},async input=>{
    if(input.operationId==='artifact-health')return reply({schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:'rbridge_status',result:{status:'RECEIPT',receipt:original}});
    const row=recipes.find(r=>r.expected.operationId===input.operationId)?.queries.find(q=>q.name==='rbridge_status');if(!row)fail();return reply(row.row,row.isError);
  });
  server.registerTool('rbridge_result',{description:'Read the one fixed Source fixture page.',inputSchema:z.strictObject({operationId:id,cursor:z.literal(0),maxBytes:z.literal(32768)}),annotations},async input=>{
    const row=recipes.find(r=>r.expected.operationId===input.operationId)?.queries.find(q=>q.name==='rbridge_result');if(!row)fail();return reply(row.row,row.isError);
  });
  return server;
}
async function main(){
  const [runtime,root,rawBinding]=process.argv.slice(3),user=userInfo(),uid=process.getuid?.();
  if(process.argv.length!==6||process.argv[2]!=='--stdio-client'||!runtime||!root||!rawBinding||uid!==1027||process.geteuid?.()!==uid
    ||user.username!=='rbridge'||process.versions.node!=='22.23.2'||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH
    ||runtime!=='/usr/local/libexec/rbridge/releases/b5881fd8367b4249e82683f1f884f2392cb696d4'
    ||!root.startsWith(user.homedir+'/.rbridge-artifact-')||!/^\.rbridge-artifact-[a-zA-Z0-9_-]{1,128}\/\.local\/state\/rbridge\/execution-v2$/.test(root.slice(user.homedir.length+1))
    ||!/^\/usr\/local\/libexec\/rbridge\/releases\/toolkit-[0-9a-f]{40}\/dist\/server\/installation\/mcpNegativeFixture\.js$/.test(fileURLToPath(import.meta.url)))fail();
  const binding=parseRBridgeDeploymentBinding(JSON.parse(rawBinding));if(binding.runtimeUid!==uid)fail();
  let current=user.homedir;for(const part of root.slice(user.homedir.length+1).split('/')){current=join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o7777)!==0o700)fail();}
  if(!(await readdir(dirname(root))).includes('relay.lock'))fail();
  const {connectRBridgeCoreIpcClient}=await import(pathToFileURL(join(runtime,'dist/server/server/rbridgeCoreIpc.js')).href) as typeof import('../server/rbridgeCoreIpc.js');
  const core=await connectRBridgeCoreIpcClient({root,expectedBinding:binding});
  try{
    const owner=await core.binding(),context={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1' as const,transport:'MCP' as const,authenticatedSubject:'uid:'+uid,principalId:binding.principalId};
    const found=await core.status('artifact-health',context);if(found.status!=='RECEIPT')fail();
    const receipt=parseRBridgeExecutionReceipt(found.receipt,{operationId:'artifact-health',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId});
    createMcpNegativeCases(binding,owner.policySha256,receipt,15000);
    const transport=new StdioServerTransport(),close=transport.close.bind(transport);transport.close=async()=>{await close();await core.close();};
    serveStdio(()=>createMcpNegativeFixtureServer(binding,owner.policySha256,receipt),{transport,legacy:'serve',onerror:()=>{process.exitCode=2;}});
  }catch(error){await core.close();throw error;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main().catch(()=>{process.stderr.write('MCP_NEGATIVE_FIXTURE_INVALID\n');process.exitCode=2;});
