import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';

const root=process.argv[2]!,mode=process.argv[3];
let helperAcquired=false;
async function killedAcknowledgementShim(handle:FileHandle):Promise<void>{
  // Acquire with the real fd-form helper, then pause the acknowledgement in this shim.
  const script="const {spawnSync}=require('node:child_process');const result=spawnSync('/usr/bin/flock',['-n','9'],{stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',9]});if(result.status!==0)process.exit(2);process.stdout.write('ACQUIRED\\n');setInterval(()=>{},1000);";
  const helper=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ignore',handle.fd]});
  await new Promise<void>((_resolve,reject)=>{
    const timer=setTimeout(()=>{helper.kill('SIGKILL');},3000);let output='';
    helper.stdout!.on('data',b=>{output+=String(b);if(output.includes('ACQUIRED\n')){helperAcquired=true;helper.kill('SIGKILL');}});
    helper.once('error',()=>{clearTimeout(timer);reject(new Error('HELPER_UNCONFIRMED'));});
    helper.once('close',()=>{clearTimeout(timer);reject(new Error('HELPER_UNCONFIRMED'));});
  });
}
try{
  const lock=await acquireRBridgeOwnerLock({root,uid:process.getuid!(),files:createRBridgeStateFiles({checkFilesystem:async()=>undefined}),...(mode==='kill-helper'?{runHelper:killedAcknowledgementShim}:{})});
  let supervisorPid:number|undefined;
  if(mode==='supervisor'){
    const supervisor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore']});
    await new Promise<void>((resolve,reject)=>{supervisor.once('spawn',resolve);supervisor.once('error',reject);});supervisorPid=supervisor.pid;supervisor.unref();
  }
  process.stdout.write(JSON.stringify({state:'HELD',pid:process.pid,inode:(await lstat(join(root,'owner.lock'))).ino,...(supervisorPid?{supervisorPid}:{})})+'\n');
  process.on('SIGTERM',()=>{void lock.close().then(()=>process.exit(0));});
  setInterval(()=>{},1000);
}catch{process.stdout.write(JSON.stringify({state:'REJECTED',helperAcquired})+'\n');process.exitCode=1;}
