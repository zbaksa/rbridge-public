import {mkdtemp,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {acquireRemoteBridgeProcessLock,createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';

const roots:string[]=[];
async function root(){const p=await mkdtemp(join(tmpdir(),'cocwin-bridge-store-'));roots.push(p);return p;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const base={requestId:'bridge.req.1',requestSha256:'a'.repeat(64),issueNumber:49,jobId:'bridge-probe-1'};
const result={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1' as const,requestId:'bridge.req.1',issueNumber:49,status:'PASS' as const,requestSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),controllerResult:{state:'SUCCEEDED'},completedAt:'2026-09-16T18:20:00.000Z'};

describe('remote bridge durable store',()=>{
  it('claims once, replays identical request, and blocks request-id collision',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,()=>new Date('2026-09-16T18:10:00.000Z'));
    const first=await store.claim(base);expect(first.state).toBe('CLAIMED');expect(first.record.phase).toBe('CLAIMED');
    const replay=await store.claim(base);expect(replay.state).toBe('REPLAY');expect(replay.record).toEqual(first.record);
    const collision=await store.claim({...base,requestSha256:'c'.repeat(64)});expect(collision.state).toBe('COLLISION');expect(collision.record.requestSha256).toBe(base.requestSha256);
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
});