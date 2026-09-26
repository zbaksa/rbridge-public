import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const roots:string[]=[];
async function root(){const value=await mkdtemp(join(tmpdir(),'bridge-health-worker-'));roots.push(value);return value;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const now=()=>new Date('2026-09-16T18:10:00.000Z');
const body=(requestId='bridge.health.1')=>JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',operation:{kind:'HEALTH',action:'STATUS'}});
const issue=(number=80,requestId='bridge.health.1')=>({number,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,body:body(requestId),authorLogin:'zbaksa',url:`https://github.com/zbaksa/cocwin-private/issues/${number}`});
const controller=()=>({submit:vi.fn(),status:vi.fn(),result:vi.fn()});
const snapshot={schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:'a'.repeat(40),uptimeMs:1000,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};

describe('stage2 HEALTH worker routing',()=>{
  it('publishes safe health without touching app controller and replays without re-snapshotting',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),health=vi.fn(()=>snapshot),publish=vi.fn(),ctl=controller();
    const first=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:ctl,health:{snapshot:health}});
    await expect(first.runOnce()).resolves.toMatchObject({seen:1,pending:0,published:1,blocked:0,errors:0});
    expect(health).toHaveBeenCalledOnce();expect(ctl.submit).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]![1]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',status:'PASS',operationResult:snapshot});
    expect((await store.get('bridge.health.1'))?.phase).toBe('PUBLISHED');
    const replayPublish=vi.fn();const replay=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue(81)],publishResult:replayPublish},controller:controller(),health:{snapshot:health}});await replay.runOnce();
    expect(health).toHaveBeenCalledOnce();expect(replayPublish.mock.calls[0]![1]).toMatchObject({status:'PASS',reason:'REPLAY'});
  });

  it('keeps a transient health failure SUBMITTED so restart can safely retry the read-only snapshot',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),failing=vi.fn(()=>{throw new Error('TRANSIENT_HEALTH_READ');});
    const first=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:vi.fn()},controller:controller(),health:{snapshot:failing}});
    const firstOut=await first.runOnce();expect(firstOut).toMatchObject({pending:1,errors:1,published:0});expect((await store.get('bridge.health.1'))?.phase).toBe('SUBMITTED');
    const good=vi.fn(()=>snapshot),publish=vi.fn();const second=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:controller(),health:{snapshot:good}});await second.runOnce();
    expect(good).toHaveBeenCalledOnce();expect(publish.mock.calls[0]![1]).toMatchObject({status:'PASS',operationResult:snapshot});expect((await store.get('bridge.health.1'))?.phase).toBe('PUBLISHED');
  });
});