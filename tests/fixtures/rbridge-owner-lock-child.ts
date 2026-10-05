import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';

const root=process.argv[2]!,mode=process.argv[3];
try{
  const lock=await acquireRBridgeOwnerLock({root,uid:process.getuid!(),files:createRBridgeStateFiles({checkFilesystem:async()=>undefined}),...(mode==='kill-helper'?{onHelper:(child:ReturnType<typeof spawn>)=>{child.once('spawn',()=>child.kill('SIGKILL'));}}:{})});
  let supervisorPid:number|undefined;
  if(mode==='supervisor'){
    const supervisor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore']});
    await new Promise<void>((resolve,reject)=>{supervisor.once('spawn',resolve);supervisor.once('error',reject);});supervisorPid=supervisor.pid;supervisor.unref();
  }
  process.stdout.write(JSON.stringify({state:'HELD',pid:process.pid,inode:(await lstat(join(root,'owner.lock'))).ino,...(supervisorPid?{supervisorPid}:{})})+'\n');
  process.on('SIGTERM',()=>{void lock.close().then(()=>process.exit(0));});
  setInterval(()=>{},1000);
}catch{process.stdout.write(JSON.stringify({state:'REJECTED'})+'\n');process.exitCode=1;}
