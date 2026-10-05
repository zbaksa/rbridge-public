import {serveStdio,StdioServerTransport,type StdioServerHandle} from '@modelcontextprotocol/server/stdio';
import {userInfo} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {RBRIDGE_CORE_LIMITS} from '../domain/rbridgeCoreProtocol.js';
import {connectRBridgeCoreIpcClient} from './rbridgeCoreIpc.js';
import {createRBridgeMcpSafeServer,resolveRBridgeMcpStdioBinding} from './rbridgeMcpSafe.js';

export function resolveRBridgeMcpStateRoot(home:string):string{
  if(!isAbsolute(home)||home==='/'||home==='/root'||home.startsWith('//')||home.includes('\0')||resolve(home)!==home)throw new Error('RBRIDGE_MCP_HOME_INVALID');
  return join(home,'.local','state','rbridge','execution-v2');
}
export async function runRBridgeMcpMain():Promise<StdioServerHandle>{
  const user=userInfo(),uid=typeof process.getuid==='function'?process.getuid():user.uid;
  const euid=typeof process.geteuid==='function'?process.geteuid():user.uid;
  if(euid!==user.uid)throw new Error('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  const binding=resolveRBridgeMcpStdioBinding(process.env,{username:user.username,uid,euid});
  const core=await connectRBridgeCoreIpcClient({root:resolveRBridgeMcpStateRoot(user.homedir),expectedBinding:{runtimeUid:uid,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId}});
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:RBRIDGE_CORE_LIMITS.requestBytes}),originalClose=transport.close.bind(transport);
  let closing:Promise<void>|undefined;
  transport.close=()=>closing??=(async()=>{try{await originalClose();}finally{await core.close();}})();
  try{
    const handle=serveStdio(()=>createRBridgeMcpSafeServer({binding,core,bindingProvider:()=>core.binding()}),{
      transport,legacy:'serve',
      onerror:()=>console.error(JSON.stringify({schema:'RBRIDGE_MCP_DIAGNOSTIC_V1',status:'ERROR',reason:'RBRIDGE_MCP_PROTOCOL_ERROR'}))
    });
    return {async close(){try{await handle.close();}finally{await transport.close();}}};
  }catch(error){await transport.close();throw error;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  void runRBridgeMcpMain().catch(error=>{const reason=error instanceof Error&&/^RBRIDGE_MCP_[A-Z_]+$/.test(error.message)?error.message:'RBRIDGE_MCP_STARTUP_FAILED';console.error(JSON.stringify({schema:'RBRIDGE_MCP_DIAGNOSTIC_V1',status:'FAIL',reason}));process.exitCode=1;});
}
