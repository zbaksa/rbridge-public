import type {RBridgeCoreBinding,RBridgeCorePort,RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeCoreIpcServerOptions{root:string;binding:RBridgeCoreBinding;core:RBridgeCorePort;files?:RBridgeStateFiles;}
export interface RBridgeCoreIpcClientOptions{root:string;expectedBinding:RBridgeDeploymentBinding;files?:RBridgeStateFiles;}
export async function startRBridgeCoreIpcServer(options:RBridgeCoreIpcServerOptions):Promise<{close():Promise<void>;connectionCount():number}>{void options;throw new Error('NOT_IMPLEMENTED');}
export async function connectRBridgeCoreIpcClient(options:RBridgeCoreIpcClientOptions):Promise<RBridgeCorePort&{binding():Promise<RBridgeCoreBinding>;close():Promise<void>}>{void options;throw new Error('NOT_IMPLEMENTED');}
