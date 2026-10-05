import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,type FileHandle} from 'node:fs/promises';
import {RBRIDGE_CORE_LIMITS} from '../domain/rbridgeCoreProtocol.js';
import {createRBridgeStateFiles,rbridgeStateFdPath,validateRBridgeStateHandle,type RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeOwnerLockOptions{root:string;uid:number;files?:RBridgeStateFiles;runHelper?:(handle:FileHandle)=>Promise<void>;beforeConfirm?:()=>Promise<void>;}
async function runFixedFlock(handle:FileHandle):Promise<void>{
  const child=spawn('/usr/bin/flock',['-n','9'],{shell:false,stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',handle.fd]});
  await new Promise<void>((resolve,reject)=>{
    let expired=false;const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},5000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('RBRIDGE_OWNER_LOCK_UNCONFIRMED'));});
    child.once('close',(code,signal)=>{clearTimeout(timer);if(code===0&&signal===null&&!expired)resolve();else reject(new Error('RBRIDGE_OWNER_LOCK_UNCONFIRMED'));});
  });
}
export async function acquireRBridgeOwnerLock(options:RBridgeOwnerLockOptions):Promise<{close():Promise<void>}>{
  const {root,uid}=options;
  if(!Number.isSafeInteger(uid)||uid<=0||process.getuid?.()!==uid||process.geteuid?.()!==uid)throw new Error('RBRIDGE_OWNER_IDENTITY_INVALID');
  const files=options.files??createRBridgeStateFiles();await files.validateTree(root,uid);
  const parent=await files.directory(root,uid,true);let handle:FileHandle|undefined;
  try{
    const path=rbridgeStateFdPath(parent,'owner.lock');
    handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    const identity=await handle.stat();validateRBridgeStateHandle(identity,uid,RBRIDGE_CORE_LIMITS.recordBytes);
    await handle.sync();await parent.sync();
    await (options.runHelper??runFixedFlock)(handle);
    await options.beforeConfirm?.();
    const visible=await lstat(path);validateRBridgeStateHandle(visible,uid,RBRIDGE_CORE_LIMITS.recordBytes);
    if(visible.dev!==identity.dev||visible.ino!==identity.ino)throw new Error('RBRIDGE_OWNER_LOCK_UNCONFIRMED');
    const retained=handle;let closing:Promise<void>|undefined;
    return Object.freeze({close(){closing??=retained.close();return closing;}});
  }catch(error){await handle?.close().catch(()=>undefined);throw error;}
  finally{await parent.close();}
}
