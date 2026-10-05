import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {createServer,type Server,Socket} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeCoreBinding,type RBridgeCorePort,type RBridgeCoreRpcRequest,type RBridgeDeploymentBinding} from '../../src/domain/rbridgeCoreProtocol.js';
import type {RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../../src/domain/rbridgeExecutionContract.js';
import {startRBridgeCoreIpcServer} from '../../src/server/rbridgeCoreIpc.js';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {acquireRemoteBridgeProcessLock} from '../../src/server/remoteBridgeStore.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';

const roots:string[]=[],cleanups:Array<()=>Promise<void>>=[],sockets=new Set<Socket>();
export async function cleanupRBridgeIpcFixtures(){for(const socket of sockets)socket.destroy();sockets.clear();for(const close of cleanups.splice(0).reverse())await close();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));}
export async function createRBridgeIpcFixture(){
  const root=await mkdtemp(join(homedir(),'.rbridge-ipc-'));roots.push(root);const uid=process.getuid!(),deployment:RBridgeDeploymentBinding={runtimeUid:uid,principalId:'operator',targetInstanceId:'aether'},binding:RBridgeCoreBinding={schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...deployment,policySha256:'a'.repeat(64),enabledActions:RBRIDGE_ENABLED_ACTIONS},files=createRBridgeStateFiles({checkFilesystem:async()=>undefined});
  const relay=await acquireRemoteBridgeProcessLock(root);cleanups.push(()=>relay.release());const owner=await acquireRBridgeOwnerLock({root,uid,files});cleanups.push(()=>owner.close());
  const calls:Array<{action:string;id:string;context:RBridgeTransportContextV1;signal?:AbortSignal;submission?:RBridgeOperationSubmissionV1}>=[];
  const scope=(id:string)=>({operationId:id,principalId:deployment.principalId,targetInstanceId:deployment.targetInstanceId});
  const core:RBridgeCorePort={
    async submit(submission,context,signal){calls.push({action:'SUBMIT',id:submission.operationId,context,signal,submission});return {status:'REJECTED',reason:'RBRIDGE_CORE_CAPACITY_REACHED',...scope(submission.operationId)};},
    async status(id,context){calls.push({action:'STATUS',id,context});return {status:'NOT_FOUND',...scope(id)};},
    async result(id,_cursor,_max,context){calls.push({action:'RESULT',id,context});return {status:'NOT_FOUND',...scope(id)};},
    async requestCancel(id,_intent,context){calls.push({action:'CANCEL_INTENT',id,context});return {status:'NOT_FOUND',...scope(id)};},
  };
  const context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:deployment.principalId};
  const submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...scope('health-1'),operation:{kind:'HEALTH',action:'STATUS'}};
  return {root,uid,deployment,binding,files,relay,owner,core,calls,scope,context,submission,
    async start(){const server=await startRBridgeCoreIpcServer({root,binding,core,files});cleanups.push(()=>server.close());return server;},
    async rogue(handler:(request:RBridgeCoreRpcRequest,socket:Socket)=>void){
      const server=createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('error',()=>undefined);socket.once('close',()=>sockets.delete(socket));let data='';socket.on('data',b=>{data+=String(b);if(data.length>65536)socket.destroy();});socket.on('end',()=>handler(JSON.parse(data.trim()) as RBridgeCoreRpcRequest,socket));});
      await listen(server,join(root,'core.sock'));await chmod(join(root,'core.sock'),0o600);cleanups.push(()=>closeServer(server));return server;
    },
  };
}
async function listen(server:Server,path:string){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});}
async function closeServer(server:Server){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
export async function rawRBridgeRpc(root:string,chunks:readonly Buffer[]):Promise<string>{
  const socket=new Socket({allowHalfOpen:true});sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  return new Promise<string>((resolve,reject)=>{
    let data='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('RAW_RPC_DEADLINE'));},12000);
    socket.on('error',error=>{clearTimeout(timer);reject(error);});socket.on('data',b=>{data+=String(b);if(Buffer.byteLength(data)>131073){socket.destroy();clearTimeout(timer);reject(new Error('RAW_RPC_LIMIT'));}});socket.on('end',()=>{clearTimeout(timer);socket.destroy();resolve(data);});
    socket.connect(join(root,'core.sock'),()=>{void (async()=>{for(const chunk of chunks){socket.write(chunk);await new Promise<void>(done=>setImmediate(done));}socket.end();})();});
  });
}
