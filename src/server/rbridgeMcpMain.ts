import {serveStdio,type StdioServerHandle} from '@modelcontextprotocol/server/stdio';
import {userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRBridgeMcpSafeServer,resolveRBridgeMcpStdioBinding} from './rbridgeMcpSafe.js';

export async function runRBridgeMcpMain():Promise<StdioServerHandle>{
  const user=userInfo(),uid=typeof process.getuid==='function'?process.getuid():user.uid;
  const euid=typeof process.geteuid==='function'?process.geteuid():user.uid;
  if(euid!==user.uid)throw new Error('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  const binding=resolveRBridgeMcpStdioBinding(process.env,{username:user.username,uid,euid});
  // P2 must supply the shared durable core. Never substitute a transport-local
  // executor or the legacy APP_RUN path merely to make this entrypoint execute.
  return serveStdio(()=>createRBridgeMcpSafeServer({binding}),{
    legacy:'serve',
    onerror:()=>console.error(JSON.stringify({schema:'RBRIDGE_MCP_DIAGNOSTIC_V1',status:'ERROR',reason:'RBRIDGE_MCP_PROTOCOL_ERROR'}))
  });
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  void runRBridgeMcpMain().catch(error=>{const reason=error instanceof Error&&/^RBRIDGE_MCP_[A-Z_]+$/.test(error.message)?error.message:'RBRIDGE_MCP_STARTUP_FAILED';console.error(JSON.stringify({schema:'RBRIDGE_MCP_DIAGNOSTIC_V1',status:'FAIL',reason}));process.exitCode=1;});
}
