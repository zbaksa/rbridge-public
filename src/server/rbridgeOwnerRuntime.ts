import type {RBridgeCorePort} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeGitHubPort,createGitHubIssueRemoteBridge} from '../adapters/githubIssueRemoteBridge.js';
import type {createRBridgeGitHubCore} from '../adapters/rbridgeGitHubCore.js';
import type {RBridgeLegacyClaimGuard} from './rbridgeOperationSerializer.js';
import type {RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeOwnerRuntimeOptions {
  runtimeIdentity:{username:string;homedir:string;uid:number;euid:number};env:Record<string,string|undefined>;
  github:RBridgeGitHubPort&Pick<ReturnType<typeof createGitHubIssueRemoteBridge>,'listOpenRequests'|'publishResult'>;
  health:{snapshot():unknown|Promise<unknown>};files?:RBridgeStateFiles;sourceRoot?:string;
}
export interface RBridgeOwnerRuntime {core:RBridgeCorePort;githubCore:ReturnType<typeof createRBridgeGitHubCore>;claimGuard:RBridgeLegacyClaimGuard;close(beforeOwnerRelease?:()=>Promise<void>):Promise<void>;}
export async function startRBridgeOwnerRuntime(_options:RBridgeOwnerRuntimeOptions):Promise<RBridgeOwnerRuntime>{void _options;throw new Error('RBRIDGE_OWNER_RUNTIME_NOT_IMPLEMENTED');}
