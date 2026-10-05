import {mkdtemp,readdir,rm,rmdir,writeFile} from 'node:fs/promises';
import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import type {RBridgeCoreBinding,RBridgeCorePort} from '../../src/domain/rbridgeCoreProtocol.js';
import type {RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {connectRBridgeCoreIpcClient,startRBridgeCoreIpcServer} from '../../src/server/rbridgeCoreIpc.js';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionJournal} from '../../src/server/rbridgeExecutionJournal.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';
import {createRBridgeReadonlyHandlers} from '../../src/server/rbridgeReadonlyHandlers.js';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {acquireRemoteBridgeProcessLock} from '../../src/server/remoteBridgeStore.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';

export function mcpTestPort(submit:RBridgeCorePort['submit']):RBridgeCorePort{
  const scope=(id:string,c:RBridgeTransportContextV1)=>({operationId:id,principalId:c.principalId,targetInstanceId:'target-test'});
  return {submit,async status(id,c){return {status:'NOT_FOUND',...scope(id,c)};},async result(id,_cursor,_max,c){return {status:'NOT_FOUND',...scope(id,c)};},async requestCancel(id,_intent,c){return {status:'NOT_FOUND',...scope(id,c)};}};
}
export async function createRBridgeStdioOwnerFixture(options:{fixedHome?:boolean;holdHealth?:boolean}={}){
  const user=userInfo(),uid=process.getuid!();
  if(uid<=0||process.geteuid!()!==uid||user.uid!==uid)throw new Error('TEST_NONROOT_OWNER_REQUIRED');
  const files=createRBridgeStateFiles({checkFilesystem:async()=>undefined});
  let root:string,relayRoot:string;
  if(options.fixedHome){
    for(const path of [join(user.homedir,'.local'),join(user.homedir,'.local','state')]){
      try{const checked=await files.directory(path,uid);await checked.close();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await files.ensureDirectory(path,uid);}
    }
    relayRoot=join(user.homedir,'.local','state','rbridge');await files.ensureDirectory(relayRoot,uid);root=join(relayRoot,'execution-v2');
  }else{root=await mkdtemp(join(homedir(),'.rbridge-stdio-'));relayRoot=root;}
  await files.validateTree(relayRoot,uid);
  const relay=await acquireRemoteBridgeProcessLock(relayRoot);
  // A positive production-entrypoint test must never touch existing user state.
  if((await readdir(relayRoot)).some(name=>name!=='relay.lock')){await relay.release();throw new Error('TEST_STATE_NOT_EMPTY');}
  const deployment={runtimeUid:uid,principalId:'operator-test',targetInstanceId:'target-test'};
  let owner:Awaited<ReturnType<typeof acquireRBridgeOwnerLock>>|undefined,core:ReturnType<typeof createRBridgeExecutionCore>|undefined,ipc:Awaited<ReturnType<typeof startRBridgeCoreIpcServer>>|undefined,sourceRoot:string|undefined;
  let releaseHealth!:()=>void,entered!:()=>void,calls=0;
  const healthGate=new Promise<void>(done=>releaseHealth=done),healthEntered=new Promise<void>(done=>entered=done);
  if(!options.holdHealth)releaseHealth();
  async function close(){
    releaseHealth();await ipc?.close();await core?.close();await owner?.close();
    // Remove only this fixture's files while relay exclusion is still held.
    for(const name of ['manifest.json','operations','results','deliveries','core.sock','owner.lock','source'])await rm(join(root,name),{recursive:true,force:true});
    if(sourceRoot)await rm(sourceRoot,{recursive:true,force:true});
    if(root!==relayRoot)await rmdir(root);await relay.release();await rmdir(relayRoot);
  }
  try{
    if(root!==relayRoot)await files.ensureDirectory(root,uid);
    owner=await acquireRBridgeOwnerLock({root,uid,files});
    const serializer=createRBridgeOperationSerializer(),policy=createRBridgeExecutionPolicy(deployment),journal=await createRBridgeExecutionJournal({root,binding:deployment,serializer,files}),results=await createRBridgeExecutionResults({root,journal,files});
    sourceRoot=await mkdtemp(join(homedir(),'.rbridge-stdio-source-'));await writeFile(join(sourceRoot,'read.txt'),'é durable read\n',{mode:0o600});
    const readonly=createRBridgeReadonlyHandlers({policy,sourceRoot,health:{async snapshot(){entered();await healthGate;return {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:'1'.repeat(40),uptimeMs:0,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};}}});
    const context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:deployment.principalId};
    const submission=(operationId='shared-stdio'):RBridgeOperationSubmissionV1=>({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId,principalId:deployment.principalId,targetInstanceId:deployment.targetInstanceId,operation:{kind:'HEALTH',action:'STATUS'}});
    core=createRBridgeExecutionCore({binding:deployment,journal,results,policy,serializer,subjects:{MCP:context.authenticatedSubject,GITHUB:'example/control:owner'},legacyReservations:{async isReserved(){return false;}},handler:{async execute(...args){calls++;return readonly.execute(...args);}}});
    await core.recover();
    const binding:RBridgeCoreBinding={schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...deployment,policySha256:policy.evaluate(submission()).snapshot.policySha256,enabledActions:policy.document.enabledActions};
    ipc=await startRBridgeCoreIpcServer({root,binding,core,files});
    return {root,user,uid,files,deployment,binding,journal,results,core,context,submission,healthEntered,releaseHealth,close,get calls(){return calls;},async stopIPC(){await ipc!.close();},async restartIPC(){ipc=await startRBridgeCoreIpcServer({root,binding,core:core!,files});},async terminal(id='shared-stdio'){const until=Date.now()+5000;while(Date.now()<until){const row=await core!.status(id,context);if(row.status==='RECEIPT'&&row.receipt.phase==='TERMINAL')return row.receipt;await new Promise<void>(done=>setTimeout(done,5));}throw new Error('TEST_TERMINAL_DEADLINE');}};
  }catch(error){await close();throw error;}
}

// A test-only real stdio process; root arguments are trusted fixture inputs.
// The production entrypoint derives its root from verified OS homedir instead.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url&&process.argv[2]==='--client'){
  const uid=process.getuid!(),root=process.argv[3]!;
  const client=await connectRBridgeCoreIpcClient({root,expectedBinding:{runtimeUid:uid,principalId:'operator-test',targetInstanceId:'target-test'},files:createRBridgeStateFiles({checkFilesystem:async()=>undefined})});
  const transport=new StdioServerTransport(),originalClose=transport.close.bind(transport);
  transport.close=async()=>{await originalClose();await client.close();};
  serveStdio(()=>createRBridgeMcpSafeServer({binding:{authenticatedSubject:`uid:${uid}`,principalId:'operator-test',targetInstanceId:'target-test'},core:client,bindingProvider:()=>client.binding()}),{transport,legacy:'serve',onerror:()=>console.error('TEST_STDIO_PROTOCOL_ERROR')});
}
