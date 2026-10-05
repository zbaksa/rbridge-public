import {dirname,join} from 'node:path';
import {createRBridgeGitHubCore} from '../adapters/rbridgeGitHubCore.js';
import {createRBridgeExecutionCore,type RBridgeExecutionCore} from './rbridgeExecutionCore.js';
import {createRBridgeExecutionJournal} from './rbridgeExecutionJournal.js';
import {createRBridgeExecutionResults} from './rbridgeExecutionResults.js';
import {createRBridgeDeliveryJournal} from './rbridgeDeliveryJournal.js';
import {createRBridgeExecutionPolicy} from './rbridgeExecutionPolicy.js';
import {createRBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
import {createRBridgeLegacyClaimGuard,createRBridgeLegacyReservations} from './rbridgeLegacyReservations.js';
import {createRBridgeReadonlyHandlers} from './rbridgeReadonlyHandlers.js';
import {createRBridgeStateFiles} from './rbridgeStateFiles.js';
import {acquireRBridgeOwnerLock} from './rbridgeOwnerLock.js';
import {assertRemoteBridgeProcessLockHeld} from './remoteBridgeStore.js';
import {resolveRBridgeMcpStateRoot} from './rbridgeMcpMain.js';
import {resolveRBridgeMcpStdioBinding} from './rbridgeMcpSafe.js';
import {startRBridgeCoreIpcServer} from './rbridgeCoreIpc.js';
import type {RBridgeCoreBinding,RBridgeCorePort} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeGitHubPort,createGitHubIssueRemoteBridge} from '../adapters/githubIssueRemoteBridge.js';
import type {RBridgeLegacyClaimGuard} from './rbridgeOperationSerializer.js';
import type {RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeOwnerRuntimeOptions {
  runtimeIdentity:{username:string;homedir:string;uid:number;euid:number};env:Record<string,string|undefined>;
  github:RBridgeGitHubPort&Pick<ReturnType<typeof createGitHubIssueRemoteBridge>,'listOpenRequests'|'publishResult'>;
  health:{snapshot():unknown|Promise<unknown>};files?:RBridgeStateFiles;sourceRoot?:string;
}
export interface RBridgeOwnerRuntime {core:RBridgeCorePort;githubCore:ReturnType<typeof createRBridgeGitHubCore>;claimGuard:RBridgeLegacyClaimGuard;close(beforeOwnerRelease?:()=>Promise<void>):Promise<void>;}
export async function startRBridgeOwnerRuntime(options:RBridgeOwnerRuntimeOptions):Promise<RBridgeOwnerRuntime>{
  const identity=options.runtimeIdentity,mcp=resolveRBridgeMcpStdioBinding(options.env,identity);
  if(process.getuid?.()!==identity.uid||process.geteuid?.()!==identity.euid)throw new Error('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  const repository=(options.env.RBRIDGE_GITHUB_REPOSITORY??'').trim(),authorLogin=(options.env.RBRIDGE_GITHUB_AUTHOR??'').trim();
  if(!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(authorLogin))throw new Error('RBRIDGE_GITHUB_CONFIG_INVALID');
  const root=resolveRBridgeMcpStateRoot(identity.homedir),parent=dirname(root),uid=identity.uid,files=options.files??createRBridgeStateFiles();
  await files.validateTree(parent,uid);await assertRemoteBridgeProcessLockHeld(parent,uid);
  await files.ensureDirectory(root,uid);
  const owner=await acquireRBridgeOwnerLock({root,uid,files});
  let core:RBridgeExecutionCore|undefined,ipc:Awaited<ReturnType<typeof startRBridgeCoreIpcServer>>|undefined,closing:Promise<void>|undefined;
  function close(beforeOwnerRelease?:()=>Promise<void>):Promise<void>{
    return closing??=(async()=>{await ipc?.close();await core?.close();await beforeOwnerRelease?.();await owner.close();})();
  }
  try{
    const binding={runtimeUid:uid,principalId:mcp.principalId,targetInstanceId:mcp.targetInstanceId},serializer=createRBridgeOperationSerializer(),policy=createRBridgeExecutionPolicy(binding);
    const journal=await createRBridgeExecutionJournal({root,binding,serializer,files}),results=await createRBridgeExecutionResults({root,journal,files}),deliveries=await createRBridgeDeliveryJournal({root,journal,files});
    const reservations=createRBridgeLegacyReservations({requestRoot:parent,flowPilotRoot:join(parent,'flowpilot'),uid});
    const handler=createRBridgeReadonlyHandlers({policy,health:options.health,...(options.sourceRoot===undefined?{}:{sourceRoot:options.sourceRoot})});
    core=createRBridgeExecutionCore({binding,journal,results,policy,serializer,subjects:{MCP:mcp.authenticatedSubject,GITHUB:repository+':'+authorLogin},legacyReservations:reservations,handler});
    await core.recover();
    const ipcBinding:RBridgeCoreBinding={schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...binding,policySha256:policy.evaluate({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'owner-binding',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation:{kind:'HEALTH',action:'STATUS'}}).snapshot.policySha256,enabledActions:policy.document.enabledActions};
    ipc=await startRBridgeCoreIpcServer({root,binding:ipcBinding,core,files});
    const githubCore=createRBridgeGitHubCore({repository,authorLogin,binding,core,deliveries,github:options.github}),claimGuard=createRBridgeLegacyClaimGuard({serializer,core:journal});
    return Object.freeze({core,githubCore,claimGuard,close});
  }catch(error){await close();throw error;}
}
