import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,link,lstat,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createRBridgeStateFiles,readRBridgeStateFile} from '../../src/server/rbridgeStateFiles.js';
const uid=process.getuid!(),roots:string[]=[];
async function root(){const dir=await mkdtemp(join(homedir(),'.rbridge-state-test-'));roots.push(dir);return dir;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const files=()=>createRBridgeStateFiles({checkFilesystem:async()=>undefined});

describe('validated durable state descriptors',()=>{
  it('reads exactly bounded regular one-link private bytes',async()=>{
    const dir=await root(),path=join(dir,'state.json');await files().commit(path,Buffer.from('abc'),uid,true);
    expect(await readRBridgeStateFile(path,uid,3)).toEqual(Buffer.from('abc'));
    await expect(readRBridgeStateFile(path,uid,2)).rejects.toThrow();
    expect((await lstat(path)).mode&0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['state.json']);
  });
  it('rejects symlink, hardlink, FIFO, owner and mode without repairing evidence',async()=>{
    const dir=await root(),path=join(dir,'state.json');await writeFile(path,'secret',{mode:0o600});
    await symlink(path,join(dir,'sym.json'));await expect(readRBridgeStateFile(join(dir,'sym.json'),uid,64)).rejects.toThrow();
    await link(path,join(dir,'linked.json'));await expect(readRBridgeStateFile(path,uid,64)).rejects.toThrow();await rm(join(dir,'linked.json'));
    await promisify(execFile)('/usr/bin/mkfifo',[join(dir,'fifo.json')]);await chmod(join(dir,'fifo.json'),0o600);
    await expect(readRBridgeStateFile(join(dir,'fifo.json'),uid,64)).rejects.toThrow();
    await expect(readRBridgeStateFile(path,uid+1,64)).rejects.toThrow();
    await chmod(path,0o644);await expect(readRBridgeStateFile(path,uid,64)).rejects.toThrow();expect((await lstat(path)).mode&0o777).toBe(0o644);expect(await readFile(path,'utf8')).toBe('secret');
    await chmod(path,0o4600);await expect(readRBridgeStateFile(path,uid,64)).rejects.toThrow();
  });
  it('rejects unsafe ancestors and linked state roots without chmod or traversal',async()=>{
    const dir=await root(),f=files();await f.validateTree(dir,uid);
    await chmod(dir,0o777);await expect(f.validateTree(dir,uid)).rejects.toThrow();expect((await lstat(dir)).mode&0o777).toBe(0o777);await chmod(dir,0o700);
    const other=await root(),alias=join(other,'alias');await symlink(dir,alias);await expect(f.validateTree(alias,uid)).rejects.toThrow();
  });
  it.each(['create','file-sync','placement','parent-sync'] as const)('does not acknowledge an unconfirmed durable commit (%s)',async fault=>{
    const dir=await root(),path=join(dir,'state.json');
    const stop=async()=>{throw new Error(`injected-${fault}`);};
    const f=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{...(fault==='create'?{beforeStageCreate:stop}:{}),...(fault==='file-sync'?{syncFile:stop}:{}),...(fault==='placement'?{beforePlacement:stop}:{}),...(fault==='parent-sync'?{syncParent:stop}:{})}});
    await expect(f.commit(path,Buffer.from('new'),uid,true)).rejects.toThrow(`injected-${fault}`);
    if(fault==='file-sync'||fault==='placement')expect((await readdir(dir)).some(p=>p.endsWith('.stage'))).toBe(true);
    if(fault==='parent-sync')expect(await readFile(path,'utf8')).toBe('new');
  });
  it('never overwrites a create winner and retains a failed replacement stage',async()=>{
    const dir=await root(),path=join(dir,'state.json');await files().commit(path,Buffer.from('winner'),uid,true);
    await expect(files().commit(path,Buffer.from('loser'),uid,true)).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('winner');
    const f=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{rename:async()=>{throw new Error('rename-failed');}}});
    await expect(f.commit(path,Buffer.from('replacement'),uid,false)).rejects.toThrow('rename-failed');expect(await readFile(path,'utf8')).toBe('winner');expect((await readdir(dir)).filter(p=>p.endsWith('.stage')).length).toBe(2);
  });
});
