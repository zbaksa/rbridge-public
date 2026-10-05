import {link,lstat,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {acquireRemoteBridgeProcessLock,createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';

const roots:string[]=[];
async function root(){const p=await mkdtemp(join(tmpdir(),'cocwin-bridge-store-'));roots.push(p);return p;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const base={requestId:'bridge.req.1',requestSha256:'a'.repeat(64),scopeSha256:'d'.repeat(64),issueNumber:49,jobId:'bridge-probe-1'};
const result={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1' as const,requestId:'bridge.req.1',issueNumber:49,status:'PASS' as const,requestSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),controllerResult:{state:'SUCCEEDED'},completedAt:'2026-09-16T18:20:00.000Z'};

describe('remote bridge durable store',()=>{
  it('claims once, replays identical request, and blocks request-id collision',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,()=>new Date('2026-09-16T18:10:00.000Z'));
    const first=await store.claim(base);expect(first.state).toBe('CLAIMED');expect(first.record.phase).toBe('CLAIMED');
    const replay=await store.claim(base);expect(replay.state).toBe('REPLAY');expect(replay.record).toEqual(first.record);
    const collision=await store.claim({...base,requestSha256:'c'.repeat(64)});expect(collision.state).toBe('COLLISION');expect(collision.record.requestSha256).toBe(base.requestSha256);
    const scopeMismatch=await store.claim({...base,scopeSha256:'e'.repeat(64)});expect(scopeMismatch.state).toBe('SCOPE_MISMATCH');
    const files=await readdir(dir);expect(files.some(f=>f.endsWith('.tmp'))).toBe(false);expect((await stat(join(dir,'bridge.req.1.json'))).mode&0o777).toBe(0o600);
  });

  it('persists phase changes across store recreation and replays terminal result',async()=>{
    const dir=await root();let store=createRemoteBridgeStore(dir);
    await store.claim(base);await store.markSubmitted(base.requestId,base.requestSha256);
    store=createRemoteBridgeStore(dir);expect((await store.get(base.requestId))?.phase).toBe('SUBMITTED');
    await store.markTerminal(base.requestId,base.requestSha256,result);
    store=createRemoteBridgeStore(dir);const replay=await store.claim(base);expect(replay.state).toBe('REPLAY');expect(replay.record.phase).toBe('TERMINAL');expect(replay.record.result).toEqual(result);
    await store.markPublished(base.requestId,base.requestSha256);
    expect((await createRemoteBridgeStore(dir).get(base.requestId))?.phase).toBe('PUBLISHED');
  });

  it('fences wrong digests and invalid phase transitions',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir);await store.claim(base);
    await expect(store.markSubmitted(base.requestId,'c'.repeat(64))).rejects.toThrow('REMOTE_BRIDGE_STORE_DIGEST_MISMATCH');
    await expect(store.markPublished(base.requestId,base.requestSha256)).rejects.toThrow('REMOTE_BRIDGE_STORE_PHASE_INVALID');
    await store.markSubmitted(base.requestId,base.requestSha256);await store.markTerminal(base.requestId,base.requestSha256,result);
    await expect(store.markSubmitted(base.requestId,base.requestSha256)).rejects.toThrow('REMOTE_BRIDGE_STORE_PHASE_INVALID');
  });

  it('enforces one global relay process lock and permits reacquire after release',async()=>{
    const dir=await root(),a=await acquireRemoteBridgeProcessLock(dir);
    await expect(acquireRemoteBridgeProcessLock(dir)).rejects.toThrow('REMOTE_BRIDGE_PROCESS_LOCKED');
    await a.release();const b=await acquireRemoteBridgeProcessLock(dir);await b.release();
  });

  it('fails closed on incomplete lock metadata instead of deleting an in-progress lock',async()=>{
    const dir=await root();await writeFile(join(dir,'relay.lock'),'',{mode:0o600});
    await expect(acquireRemoteBridgeProcessLock(dir)).rejects.toThrow('REMOTE_BRIDGE_PROCESS_LOCKED');
    expect((await stat(join(dir,'relay.lock'))).isFile()).toBe(true);
  });

  it('reclaims a complete stale lock without an ABA unlink race',async()=>{
    const dir=await root();await writeFile(join(dir,'relay.lock'),'2147483647\n',{mode:0o600});
    const lock=await acquireRemoteBridgeProcessLock(dir);
    await expect(acquireRemoteBridgeProcessLock(dir)).rejects.toThrow('REMOTE_BRIDGE_PROCESS_LOCKED');
    await lock.release();
  });

  it.each(['FIFO','symlink','hardlink','oversized','shared-mode'] as const)('refuses an unsafe relay lock without blocking, following or deleting it (%s)',async kind=>{
    const dir=await root(),path=join(dir,'relay.lock'),target=join(dir,'retained-target'),stale='2147483647\n';
    if(kind==='FIFO')execFileSync('/usr/bin/mkfifo',['-m','600',path]);
    else if(kind==='symlink'){execFileSync('/usr/bin/mkfifo',['-m','600',target]);await symlink(target,path);}
    else if(kind==='hardlink'){await writeFile(target,stale,{mode:0o600});await link(target,path);}
    else await writeFile(path,kind==='oversized'?stale+' '.repeat(65536):stale,{mode:kind==='shared-mode'?0o644:0o600});
    const before=await lstat(path),bytes=before.isFile()?await readFile(path):undefined;
    const child=spawn(process.execPath,['--import','tsx','tests/fixtures/rbridge-relay-lock-child.ts',dir],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;child.stdout.on('data',data=>stdout+=String(data));child.stderr.on('data',data=>stderr+=String(data));
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},3000);
    try{await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>resolve());});}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    expect(stdout).toContain('BEFORE_ACQUIRE\n');expect(stderr).toBe('');expect(timedOut).toBe(false);expect(stdout).toContain('REJECTED:REMOTE_BRIDGE_PROCESS_LOCKED\n');expect(stdout).not.toContain('ACQUIRED\n');
    const after=await lstat(path);expect(after.ino).toBe(before.ino);expect(after.mode).toBe(before.mode);expect(after.nlink).toBe(before.nlink);
    if(bytes)expect(await readFile(path)).toEqual(bytes);
    if(kind==='symlink')expect((await lstat(target)).isFIFO()).toBe(true);
    if(kind==='hardlink')expect(await readFile(target,'utf8')).toBe(stale);
  },10000);
});
