import type {ChildProcess} from 'node:child_process';
import type {RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeOwnerLockOptions{root:string;uid:number;files?:RBridgeStateFiles;onHelper?:(child:ChildProcess)=>void;beforeConfirm?:()=>Promise<void>;}
export async function acquireRBridgeOwnerLock(_options:RBridgeOwnerLockOptions):Promise<{close():Promise<void>}>{throw new Error('NOT_IMPLEMENTED');}
