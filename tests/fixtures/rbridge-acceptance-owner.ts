import type {ChildProcess} from 'node:child_process';
import type {Client} from '@modelcontextprotocol/client';
import type {GitHubBridgeIssue,RBridgeGitHubComment} from '../../src/adapters/githubIssueRemoteBridge.js';
import type {RBridgeDeploymentBinding} from '../../src/domain/rbridgeCoreProtocol.js';
import type {RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../../src/domain/rbridgeExecutionContract.js';
export interface RBridgeAcceptanceActor {child:ChildProcess;request(command:string,value?:unknown):Promise<unknown>;event(name:string,count?:number):Promise<void>;kill():Promise<void>;close():Promise<void>;}
export interface RBridgeAcceptanceFixture {home:string;root:string;sourceRoot:string;binding:RBridgeDeploymentBinding;context:RBridgeTransportContextV1;issues:Map<number,GitHubBridgeIssue&{state:'open'|'closed'}>;comments:Map<number,RBridgeGitHubComment[]>;submission(id?:string,operation?:RBridgeOperationSubmissionV1['operation']):RBridgeOperationSubmissionV1;issue(id?:string):GitHubBridgeIssue;start(options?:{holdRead?:boolean;holdHealth?:boolean;holdClaim?:boolean;fullResult?:boolean;target?:string}):Promise<RBridgeAcceptanceActor>;stdio(era:'legacy'|'modern'):Promise<Client>;failCloseOnce():void;close():Promise<void>;}
export async function createRBridgeAcceptanceFixture():Promise<RBridgeAcceptanceFixture>{if(process.getuid!()<=0)throw new Error('TEST_NONROOT_OWNER_REQUIRED');throw new Error('RBRIDGE_ACCEPTANCE_FIXTURE_NOT_IMPLEMENTED');}
