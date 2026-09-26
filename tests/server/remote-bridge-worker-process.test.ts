import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const roots:string[]=[];
async function root(){const value=await mkdtemp(join(tmpdir(),'bridge-process-worker-'));roots.push(value);return value;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const now=()=>new Date('2026-09-16T18:10:00.000Z');
const body=(requestId='bridge.process.1')=>JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',operation:{kind:'PROCESS',action:'START',args:{profileId:'stdin-echo',cwd:'/mnt/data',argv:[],lifetimeMs:5000}}});
const issue=(number=90,requestId='bridge.process.1')=>({number,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,body:body(requestId),authorLogin:'zbaksa',url:`https://github.com/zbaksa/cocwin-private/issues/${number}`});
const controller=()=>({submit:vi.fn(),status:vi.fn(),result:vi.fn()});

describe('stage2 PROCESS worker routing',()=>{
  it('routes PROCESS through the dedicated session port and replays published result without a second start',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),publish=vi.fn(),ctl=controller();
    const execute=vi.fn(async(_operation:unknown,digest:string)=>({schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1',sessionId:'1'.repeat(32),ownerDigest:digest,state:'RUNNING'}));
    const first=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:ctl,processSessions:{execute}});
    await expect(first.runOnce()).resolves.toMatchObject({seen:1,pending:0,published:1,blocked:0,errors:0});
    expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]![1]).toMatch(/^[a-f0-9]{64}$/);expect(ctl.submit).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]![1]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',status:'PASS',operationResult:{state:'RUNNING'}});
    const replayPublish=vi.fn();const replay=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue(91)],publishResult:replayPublish},controller:controller(),processSessions:{execute}});
    await replay.runOnce();expect(execute).toHaveBeenCalledOnce();expect(replayPublish.mock.calls[0]![1]).toMatchObject({status:'PASS',reason:'REPLAY'});
  });

  it('fails closed when PROCESS is not configured',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),publish=vi.fn();
    const worker=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:controller()});
    await expect(worker.runOnce()).resolves.toMatchObject({published:1,blocked:1,errors:0});
    expect(publish.mock.calls[0]![1]).toMatchObject({status:'BLOCKED',reason:'REMOTE_BRIDGE_STAGE2_PROCESS_NOT_CONFIGURED'});
  });

  it('preserves may-have-executed PROCESS failures as UNCERTAIN instead of BLOCKED',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),publish=vi.fn();
    const execute=vi.fn(async()=>{throw new Error('REMOTE_BRIDGE_PROCESS_INPUT_WRITE_UNCERTAIN');});
    const worker=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:controller(),processSessions:{execute}});
    await expect(worker.runOnce()).resolves.toMatchObject({published:1,blocked:0,errors:0});
    expect(publish.mock.calls[0]![1]).toMatchObject({status:'UNCERTAIN',reason:'REMOTE_BRIDGE_PROCESS_INPUT_WRITE_UNCERTAIN'});
  });
  it('publishes ambiguous PROCESS START as UNCERTAIN',async()=>{
    const dir=await root(),store=createRemoteBridgeStore(dir,now),publish=vi.fn();
    const execute=vi.fn(async()=>{throw new Error('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');});
    const worker=createRemoteBridgeWorker({now,store,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:controller(),processSessions:{execute}});
    await expect(worker.runOnce()).resolves.toMatchObject({published:1,blocked:0,errors:0});
    expect(publish.mock.calls[0]![1]).toMatchObject({status:'UNCERTAIN',reason:'REMOTE_BRIDGE_PROCESS_START_UNCERTAIN'});
  });

});
