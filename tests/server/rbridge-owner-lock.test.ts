import {spawn,type ChildProcess} from 'node:child_process';
import {chmod,link,lstat,mkdtemp,readFile,readdir,rm,statfs,symlink,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {checkPersistentRBridgeFilesystem,createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';

const roots:string[]=[],children:ChildProcess[]=[],supervisors:number[]=[],locks:Array<{close():Promise<void>}>=[];
const files=()=>createRBridgeStateFiles({checkFilesystem:async()=>undefined});
async function root(){const path=await mkdtemp(join(homedir(),'.rbridge-owner-lock-'));roots.push(path);return path;}
function exited(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();return new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
afterEach(async()=>{for(const child of children.splice(0)){child.kill('SIGKILL');await exited(child);}for(const pid of supervisors.splice(0))try{process.kill(pid,'SIGKILL');}catch{}await Promise.all(locks.splice(0).map(lock=>lock.close()));await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function owner(path:string,mode='hold'){
  const child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/rbridge-owner-lock-child.ts'),path,mode],{stdio:['ignore','pipe','pipe']});children.push(child);
  const message=await new Promise<{state:string;pid?:number;inode?:number;supervisorPid?:number}>((done,reject)=>{
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('OWNER_FIXTURE_DEADLINE'));},5000);
    const fail=(error:Error)=>{clearTimeout(timer);reject(error);};child.once('error',fail);
    child.stderr!.on('data',b=>{stderr+=String(b);if(stderr.length>8192)fail(new Error('OWNER_FIXTURE_STDERR_LIMIT'));});
    child.stdout!.on('data',b=>{stdout+=String(b);if(stdout.length>8192){fail(new Error('OWNER_FIXTURE_STDOUT_LIMIT'));return;}if(stdout.includes('\n')){clearTimeout(timer);try{done(JSON.parse(stdout.split('\n')[0]!));}catch{reject(new Error('OWNER_FIXTURE_INVALID'));}}});
    child.once('exit',()=>{if(!stdout.includes('\n'))fail(new Error('OWNER_FIXTURE_EXIT '+stderr.slice(0,512)));});
  });
  if(message.supervisorPid)supervisors.push(message.supervisorPid);return {child,message};
}

describe('owner-lifetime Linux flock',()=>{
  it('helper exit does not release a live owner lock and close preserves its inode',async()=>{
    const path=await root(),first=await acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()});locks.push(first);const inode=(await lstat(join(path,'owner.lock'))).ino;
    expect((await owner(path)).message.state).toBe('REJECTED');await first.close();await first.close();
    const second=await acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()});locks.push(second);expect((await lstat(join(path,'owner.lock'))).ino).toBe(inode);expect(await readdir(path)).toEqual(['owner.lock']);
  });
  it('two real owners exclude each other until the first releases',async()=>{
    const path=await root(),first=await owner(path);expect(first.message.state).toBe('HELD');expect((await owner(path)).message.state).toBe('REJECTED');first.child.kill('SIGTERM');await exited(first.child);const replacement=await owner(path);expect(replacement.message.state).toBe('HELD');expect(replacement.message.inode).toBe(first.message.inode);
  });
  it('owner death releases despite a surviving child without sharing its descriptor',async()=>{
    const path=await root(),first=await owner(path,'supervisor');expect(first.message.state).toBe('HELD');expect(first.message.supervisorPid).toBeDefined();first.child.kill('SIGKILL');await exited(first.child);expect(()=>process.kill(first.message.supervisorPid!,0)).not.toThrow();
    const replacement=await owner(path);expect(replacement.message.state).toBe('HELD');expect(replacement.message.inode).toBe(first.message.inode);
  });
  it('killed helper never confirms acquisition and cleanup permits a replacement',async()=>{
    const path=await root(),killed=await owner(path,'kill-helper');expect(killed.message.state).toBe('REJECTED');await exited(killed.child);expect((await owner(path)).message.state).toBe('HELD');
  });
  it('unconfirmed acquisition never starts IPC and closes the actually acquired descriptor',async()=>{
    const path=await root();let ipcStarts=0;
    await expect((async()=>{const lock=await acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files(),beforeConfirm:async()=>{throw new Error('ACK_UNCONFIRMED');}});locks.push(lock);ipcStarts++;})()).rejects.toThrow('ACK_UNCONFIRMED');expect(ipcStarts).toBe(0);
    const replacement=await acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()});locks.push(replacement);expect(await readdir(path)).toEqual(['owner.lock']);
  });
  it('refuses unsafe or foreign lock identity without deleting or chmodding evidence',async()=>{
    const path=await root(),lockPath=join(path,'owner.lock');await writeFile(lockPath,'retained',{mode:0o644});await expect(acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()})).rejects.toThrow();expect((await lstat(lockPath)).mode&0o777).toBe(0o644);expect(await readFile(lockPath,'utf8')).toBe('retained');
    await chmod(lockPath,0o600);await link(lockPath,join(path,'hardlink'));await expect(acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()})).rejects.toThrow();expect((await lstat(lockPath)).nlink).toBe(2);await rm(lockPath);await symlink(join(path,'hardlink'),lockPath);await expect(acquireRBridgeOwnerLock({root:path,uid:process.getuid!(),files:files()})).rejects.toThrow();expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    await expect(acquireRBridgeOwnerLock({root:path,uid:process.getuid!()+1,files:files()})).rejects.toThrow();
  });
  it('refuses root and unsupported real filesystem types without a runtime override',async()=>{
    const path=await root();await expect(acquireRBridgeOwnerLock({root:path,uid:0,files:files()})).rejects.toThrow();expect(await readdir(path)).toEqual([]);
    await expect(checkPersistentRBridgeFilesystem('/dev/shm')).rejects.toThrow('RBRIDGE_STATE_FILESYSTEM_UNSUPPORTED');const actual=await statfs(path);if([0xef53,0x58465342,0x9123683e].includes(actual.type))await expect(checkPersistentRBridgeFilesystem(path)).resolves.toBeUndefined();else await expect(checkPersistentRBridgeFilesystem(path)).rejects.toThrow('RBRIDGE_STATE_FILESYSTEM_UNSUPPORTED');
  });
});
