import type {GitHubBridgeIssue,RBridgeGitHubPort} from './githubIssueRemoteBridge.js';
import type {RBridgeCorePort,RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeDeliveryJournal} from '../server/rbridgeDeliveryJournal.js';
export interface RBridgeGitHubCoreOptions {repository:string;authorLogin:string;binding:RBridgeDeploymentBinding;core:RBridgeCorePort;deliveries:RBridgeDeliveryJournal;github:RBridgeGitHubPort;now?:()=>Date;}
export function createRBridgeGitHubCore(_options:RBridgeGitHubCoreOptions){
  void _options;return {async admit(_issue:GitHubBridgeIssue):Promise<'CORE'|'PUBLICATION_UNAVAILABLE'>{void _issue;throw new Error('NOT_IMPLEMENTED');},async reconcileDeliveries(_limit:number):Promise<void>{void _limit;throw new Error('NOT_IMPLEMENTED');}};
}
