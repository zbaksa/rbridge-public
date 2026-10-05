import type {Stats} from 'node:fs';
import {chmod,lstat,unlink,type FileHandle} from 'node:fs/promises';
import {createServer,Socket} from 'node:net';
import {RBRIDGE_CORE_LIMITS as limits,type RBridgeCoreBinding,type RBridgeCorePort,type RBridgeCoreRpcRequest,type RBridgeCoreRpcResponse,type RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {parseRBridgeCoreBinding,parseRBridgeCoreRpcRequest,parseRBridgeCoreRpcResponse,parseRBridgeDeploymentBinding} from '../domain/rbridgeCoreValidation.js';
import {rbridgeOperationIntentDigest,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {freezeRBridgeValue} from './rbridgeExecutionPolicy.js';
import {parseRBridgeTransportContext} from './rbridgeExecutionJournal.js';
import {assertRBridgeOwnerLockHeld} from './rbridgeOwnerLock.js';
import {createRBridgeStateFiles,rbridgeStateFdPath,type RBridgeStateFiles} from './rbridgeStateFiles.js';
export function decodeRBridgeRpcFrame(data:Buffer,maxBytes:number):unknown{
  if(data.length>maxBytes)throw new Error('RBRIDGE_CORE_RPC_LIMIT');
  if(data.length<2||data.indexOf(10)!==data.length-1)throw new Error('RBRIDGE_CORE_RPC_INVALID');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,-1))) as unknown;}
  catch{throw new Error('RBRIDGE_CORE_RPC_INVALID');}
}
export interface RBridgeCoreIpcServerOptions{root:string;binding:RBridgeCoreBinding;core:RBridgeCorePort;files?:RBridgeStateFiles;}
export interface RBridgeCoreIpcClientOptions{root:string;expectedBinding:RBridgeDeploymentBinding;files?:RBridgeStateFiles;}
function fail(reason='RBRIDGE_CORE_RPC_UNAVAILABLE'):never{throw new Error(reason);}
function runtime(uid:number){if(uid<=0||process.getuid?.()!==uid||process.geteuid?.()!==uid)fail();}
function socketIdentity(info:Stats,uid:number){if(!info.isSocket()||info.uid!==uid||info.nlink!==1||(info.mode&0o7777)!==0o600)fail();}
function encoded(value:unknown,maxBytes:number):Buffer{const data=Buffer.from(JSON.stringify(value)+'\n');if(data.length>maxBytes)fail('RBRIDGE_CORE_RPC_LIMIT');return data;}
const activeServers=new Set<string>();
export async function startRBridgeCoreIpcServer(options:RBridgeCoreIpcServerOptions):Promise<{close():Promise<void>;connectionCount():number}>{
  const binding=freezeRBridgeValue(parseRBridgeCoreBinding(options.binding)),uid=binding.runtimeUid;runtime(uid);assertRBridgeOwnerLockHeld(options.root);
  if(activeServers.has(options.root))fail();activeServers.add(options.root);
  const files=options.files??createRBridgeStateFiles();let parent:FileHandle|undefined;
  const sockets=new Set<Socket>(),slots=new Set<Socket>(),delegations=new Set<Promise<void>>();let ready=false,closing:Promise<void>|undefined;
  const server=createServer({allowHalfOpen:true},socket=>{
    socket.on('error',()=>undefined);
    if(!ready||slots.size>=limits.connections){socket.destroy();return;}
    sockets.add(socket);slots.add(socket);let delegationActive=false;
    const releaseSlot=()=>{if(!sockets.has(socket)&&!delegationActive)slots.delete(socket);};
    const buffer=Buffer.alloc(limits.requestBytes),controller=new AbortController();let total=0,finished=false,rpcTimer:ReturnType<typeof setTimeout>|undefined;
    const frameTimer=setTimeout(()=>finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:'RBRIDGE_CORE_RPC_LIMIT'},true),limits.frameMs);
    function finish(response:RBridgeCoreRpcResponse,abort=false){
      if(finished)return;finished=true;clearTimeout(frameTimer);clearTimeout(rpcTimer);if(abort)controller.abort();
      try{socket.end(encoded(response,limits.responseBytes));}catch{socket.destroy();}
    }
    socket.once('close',()=>{sockets.delete(socket);clearTimeout(frameTimer);clearTimeout(rpcTimer);if(!finished){finished=true;controller.abort();}releaseSlot();});
    socket.on('data',(data:Buffer)=>{if(finished)return;if(total+data.length>limits.requestBytes){finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:'RBRIDGE_CORE_RPC_LIMIT'},true);return;}data.copy(buffer,total);total+=data.length;});
    socket.once('end',()=>{delegationActive=true;const work=(async()=>{
      if(finished||!ready)return;clearTimeout(frameTimer);let request:RBridgeCoreRpcRequest;
      try{assertRBridgeOwnerLockHeld(options.root);request=parseRBridgeCoreRpcRequest(decodeRBridgeRpcFrame(buffer.subarray(0,total),limits.requestBytes));}
      catch(error){finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:(error as Error).message==='RBRIDGE_CORE_RPC_LIMIT'?'RBRIDGE_CORE_RPC_LIMIT':'RBRIDGE_CORE_RPC_INVALID'},true);return;}
      const context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:binding.principalId,requestRef:`ipc:${request.action}${request.action==='BINDING'?'':':'+(request.action==='SUBMIT'?request.submission.operationId:request.operationId)}`};
      rpcTimer=setTimeout(()=>finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:'RBRIDGE_CORE_RPC_UNAVAILABLE'},true),limits.rpcMs);
      try{
        let value:RBridgeCoreRpcResponse&{schema:'RBRIDGE_CORE_RPC_RESULT_V1'};
        switch(request.action){
          case 'BINDING':value={schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:request.action,value:binding};break;
          case 'SUBMIT':value={schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:request.action,value:await options.core.submit(request.submission,context,controller.signal)};break;
          case 'STATUS':value={schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:request.action,value:await options.core.status(request.operationId,context)};break;
          case 'RESULT':value={schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:request.action,value:await options.core.result(request.operationId,request.cursor,request.maxBytes,context)};break;
          case 'CANCEL_INTENT':value={schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:request.action,value:await options.core.requestCancel(request.operationId,request.intentSha256,context)};break;
        }
        finish(parseRBridgeCoreRpcResponse(value,request,binding));
      }catch{finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:'RBRIDGE_CORE_RPC_UNAVAILABLE'},true);}
    })();delegations.add(work);
      const settled=()=>{delegationActive=false;delegations.delete(work);releaseSlot();};
      void work.then(settled,()=>{settled();finish({schema:'RBRIDGE_CORE_RPC_ERROR_V1',reason:'RBRIDGE_CORE_RPC_UNAVAILABLE'},true);});
    });
  });
  try{
    await files.validateTree(options.root,uid);parent=await files.directory(options.root,uid,true);const path=rbridgeStateFdPath(parent,'core.sock');
    try{socketIdentity(await lstat(path),uid);assertRBridgeOwnerLockHeld(options.root);await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});
    await chmod(path,0o600);socketIdentity(await lstat(path),uid);assertRBridgeOwnerLockHeld(options.root);ready=true;
    const retained=parent;
    return Object.freeze({connectionCount:()=>sockets.size,close(){closing??=(async()=>{ready=false;for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));while(delegations.size)await Promise.allSettled([...delegations]);await retained.close();activeServers.delete(options.root);})();return closing;}});
  }catch(error){ready=false;for(const socket of sockets)socket.destroy();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await parent?.close().catch(()=>undefined);activeServers.delete(options.root);throw error;}
}
export async function connectRBridgeCoreIpcClient(options:RBridgeCoreIpcClientOptions):Promise<RBridgeCorePort&{binding():Promise<RBridgeCoreBinding>;close():Promise<void>}>{
  const expected=freezeRBridgeValue(parseRBridgeDeploymentBinding(options.expectedBinding)),uid=expected.runtimeUid;runtime(uid);const files=options.files??createRBridgeStateFiles();await files.validateTree(options.root,uid);
  const sockets=new Set<Socket>();let closed=false;
  function context(value:RBridgeTransportContextV1){const c=parseRBridgeTransportContext(value);if(c.transport!=='MCP'||c.principalId!==expected.principalId||c.authenticatedSubject!==`uid:${uid}`)fail('RBRIDGE_CORE_SCOPE_INVALID');}
  async function rpc(request:RBridgeCoreRpcRequest,signal?:AbortSignal,onSent?:()=>void):Promise<RBridgeCoreRpcResponse>{
    if(closed||signal?.aborted)fail();const validated=parseRBridgeCoreRpcRequest(request),payload=encoded(validated,limits.requestBytes),parent=await files.directory(options.root,uid,true);
    try{
      const path=rbridgeStateFdPath(parent,'core.sock');socketIdentity(await lstat(path),uid);if(closed||signal?.aborted)fail();
      const socket=new Socket({allowHalfOpen:true});sockets.add(socket);const buffer=Buffer.alloc(limits.responseBytes);let total=0;
      const bytes=await new Promise<Buffer>((resolve,reject)=>{
        let settled=false;const timer=setTimeout(()=>done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE')),limits.rpcMs);
        const abort=()=>done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE'));
        function done(error?:Error){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){socket.destroy();reject(error);}else resolve(buffer.subarray(0,total));}
        signal?.addEventListener('abort',abort,{once:true});socket.on('error',()=>done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE')));
        socket.on('data',(data:Buffer)=>{if(settled)return;if(total+data.length>limits.responseBytes){done(new Error('RBRIDGE_CORE_RPC_LIMIT'));return;}data.copy(buffer,total);total+=data.length;});
        socket.once('end',()=>done());socket.once('close',()=>done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE')));
        socket.connect(path,()=>{if(closed||signal?.aborted){done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE'));return;}try{onSent?.();socket.end(payload);}catch{done(new Error('RBRIDGE_CORE_RPC_UNAVAILABLE'));}});
      }).finally(()=>{socket.destroy();sockets.delete(socket);});
      const response=parseRBridgeCoreRpcResponse(decodeRBridgeRpcFrame(bytes,limits.responseBytes),validated,expected);
      if(response.schema==='RBRIDGE_CORE_RPC_ERROR_V1')fail(response.reason);return response;
    }finally{await parent.close();}
  }
  async function binding():Promise<RBridgeCoreBinding>{
    const response=await rpc({schema:'RBRIDGE_CORE_RPC_V1',action:'BINDING'});if(response.schema!=='RBRIDGE_CORE_RPC_RESULT_V1')fail();
    const value=parseRBridgeCoreBinding(response.value);if(value.runtimeUid!==uid||value.principalId!==expected.principalId||value.targetInstanceId!==expected.targetInstanceId)fail('RBRIDGE_CORE_SCOPE_INVALID');return freezeRBridgeValue(value);
  }
  async function query(request:RBridgeCoreRpcRequest,c:RBridgeTransportContextV1){context(c);await binding();return (await rpc(request) as RBridgeCoreRpcResponse&{schema:'RBRIDGE_CORE_RPC_RESULT_V1'}).value;}
  const client:RBridgeCorePort&{binding():Promise<RBridgeCoreBinding>;close():Promise<void>}={
    binding,
    async submit(submission,c,signal){
      context(c);if(signal.aborted)fail();const request=parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',action:'SUBMIT',submission});if(request.action!=='SUBMIT')fail();
      if(request.submission.principalId!==expected.principalId||request.submission.targetInstanceId!==expected.targetInstanceId)fail('RBRIDGE_CORE_SCOPE_INVALID');await binding();let sent=false;
      try{const response=await rpc(request,signal,()=>{sent=true;});return (response as RBridgeCoreRpcResponse&{schema:'RBRIDGE_CORE_RPC_RESULT_V1'}).value as Awaited<ReturnType<RBridgeCorePort['submit']>>;}
      catch{if(sent)try{await rpc({schema:'RBRIDGE_CORE_RPC_V1',action:'CANCEL_INTENT',operationId:request.submission.operationId,intentSha256:rbridgeOperationIntentDigest(request.submission)});}catch{}fail();}
    },
    async status(operationId,c){return await query({schema:'RBRIDGE_CORE_RPC_V1',action:'STATUS',operationId},c) as Awaited<ReturnType<RBridgeCorePort['status']>>;},
    async result(operationId,cursor,maxBytes,c){return await query({schema:'RBRIDGE_CORE_RPC_V1',action:'RESULT',operationId,cursor,maxBytes},c) as Awaited<ReturnType<RBridgeCorePort['result']>>;},
    async requestCancel(operationId,intentSha256,c){return await query({schema:'RBRIDGE_CORE_RPC_V1',action:'CANCEL_INTENT',operationId,intentSha256},c) as Awaited<ReturnType<RBridgeCorePort['requestCancel']>>;},
    async close(){closed=true;for(const socket of sockets)socket.destroy();},
  };
  try{await binding();return Object.freeze(client);}catch(error){await client.close();throw error;}
}
