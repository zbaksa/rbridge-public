import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';

/** Fixed Linux peer writers share a permanent inode; the kernel releases ownership on process exit. */
export async function withPrivateLinuxFileGate<T>(root:string,prefix:string,fn:()=>Promise<T>):Promise<T>{
  if(process.platform!=='linux'||! /^[A-Z_]{1,64}$/.test(prefix))throw Error('RBRIDGE_KERNEL_GATE_PLATFORM_INVALID');
  const fail=(code:string):never=>{throw Error(prefix+'_'+code);},path=join(root,'writer.kernel.lock');
  const directory=await lstat(root);if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)!==0||directory.uid!==process.getuid?.()||await realpath(root)!==root)fail('PRIVATE_ROOT_INVALID');
  const legacy=async()=>{try{await lstat(join(root,'writer.lock'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}fail('LEGACY_WRITER_UNVERIFIED');};
  await legacy();
  const handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  try{
    const identity=await handle.stat();
    const check=async()=>{const now=await lstat(path);if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1||now.size!==0||(now.mode&0o077)!==0||now.uid!==process.getuid?.()||now.dev!==identity.dev||now.ino!==identity.ino)fail('LOCK_IDENTITY_CHANGED');};
    if(!identity.isFile()||identity.nlink!==1||identity.size!==0||(identity.mode&0o077)!==0||identity.uid!==process.getuid?.())fail('PRIVATE_LOCK_INVALID');
    await handle.sync();const parent=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
    await new Promise<void>((resolve,reject)=>{
      // No shell, wire arguments or selected executable: fd3 duplicates this validated open file description.
      const child=spawn('/usr/bin/flock',['--exclusive','--timeout','2','--conflict-exit-code','73','3'],{stdio:['ignore','ignore','ignore',handle.fd]});
      let done=false;const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timeout);if(error)reject(error);else resolve();};
      const timeout=setTimeout(()=>{child.kill('SIGKILL');finish(Error(prefix+'_LOCK_SERVICE_TIMEOUT'));},3500);
      child.once('error',()=>finish(Error(prefix+'_LOCK_SERVICE_UNAVAILABLE')));
      child.once('close',code=>finish(code===0?undefined:Error(prefix+(code===73?'_WRITER_BUSY':'_LOCK_SERVICE_UNAVAILABLE'))));
    });
    await check();await legacy();const value=await fn();await check();await legacy();return value;
  }finally{await handle.close();}
}
