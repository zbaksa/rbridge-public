import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const TRANSPORT={repository:'example/rbridge-control',authorLogin:'bridge-owner'} as const;
const NOW=()=>new Date('2026-10-30T17:05:00.000Z');
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function durable(){
  const p=await mkdtemp(join(tmpdir(),'rbridge-live-owner-hold-'));
  roots.push(p);
  return {root:p,store:createRemoteBridgeStore(p,NOW)};
}
function v2Issue(number=91,appId='dart',jobId='dart-hold-job',requestId='rbridge.owner.hold.v2'){
  return {number,title:'[COCWIN BRIDGE REQUEST] '+requestId,authorLogin:TRANSPORT.authorLogin,
    url:'https://github.com/example/rbridge-control/issues/'+number,
    body:JSON.stringify({
      schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,
      createdAt:'2026-10-30T17:00:00.000Z',expiresAt:'2026-10-30T17:10:00.000Z',
      operation:{kind:'APP_RUN',appId,jobId,payload:{tool:'node',cwd:'/home/rbridge/backend',
        args:['--version'],timeout_ms:30000,max_bytes:65536}}
    })};
}
function v1Issue(){
  const requestId='rbridge.owner.hold.v1';
  return {number:92,title:'[COCWIN BRIDGE REQUEST] '+requestId,authorLogin:TRANSPORT.authorLogin,
    url:'https://github.com/example/rbridge-control/issues/92',
    body:JSON.stringify({
      schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId,
      createdAt:'2026-10-30T17:00:00.000Z',expiresAt:'2026-10-30T17:10:00.000Z',
      appId:'aplall',jobId:'aplall-original-job',operation:'RUN',
      payload:{tool:'node',cwd:'/home/rbridge/backend',
        args:['--version'],timeout_ms:30000,max_bytes:65536}
    })};
}
function ctl(submit=vi.fn(async()=>({state:'QUEUED'}))){
  return {submit,status:vi.fn(async()=>({state:'RUNNING'})),result:vi.fn(async()=>({state:'SUCCEEDED'}))};
}

describe('live-based protected owner HOLD before legacy V1/V2 controller effects',()=>{
  it('preserves byte-identical durable V2 WAITING after original writer contention clears',async()=>{
    const {root,store}=await durable(),issue=v2Issue(),publish=vi.fn(async()=>{});
    const firstSubmit=vi.fn(async()=>({state:'BLOCKED',
      reason:'application already has an active or uncertain writer'}));
    const first=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},controller:ctl(firstSubmit)});
    expect(await first.runOnce()).toMatchObject({pending:1,published:0});
    expect(firstSubmit).toHaveBeenCalledOnce();
    const original=await store.get('rbridge.owner.hold.v2');
    expect(original).toMatchObject({phase:'WAITING',issueNumber:91,jobId:'dart-hold-job'});
    const path=join(root,'rbridge.owner.hold.v2.json');
    const before=await readFile(path);
    const newSubmit=vi.fn(async()=>({state:'SUCCEEDED'}));
    const hold=vi.fn(async()=>true);
    const afterWorker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller:ctl(newSubmit),admissionHold:hold});
    expect(await afterWorker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect(hold).toHaveBeenCalledWith({
      appId:'dart',requestId:'rbridge.owner.hold.v2',jobId:'dart-hold-job',
      requestSha256:original?.requestSha256,issueNumber:91
    });
    expect(newSubmit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(before);
  });

  it('holds new V2 request in WAITING, without controller call or result publication',async()=>{
    const {store}=await durable(),issue=v2Issue(),controller=ctl(),publish=vi.fn();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller,admissionHold:async()=>true});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect((await store.get('rbridge.owner.hold.v2'))?.phase).toBe('WAITING');
    expect(controller.submit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails closed on unverifiable owner policy for V2',async()=>{
    const {store}=await durable(),issue=v2Issue(),controller=ctl(),publish=vi.fn();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller,admissionHold:async()=>{throw Error('OWNER_HOLD_PROOF_UNAVAILABLE');}});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:1});
    expect((await store.get('rbridge.owner.hold.v2'))?.phase).toBe('WAITING');
    expect(controller.submit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not block an explicitly unheld app in ordinary V2 behavior',async()=>{
    const {store}=await durable(),issue=v2Issue(93,'games2d','games2d-safe-job','rbridge.other.app'),
      controller=ctl(),publish=vi.fn();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller,admissionHold:async({appId})=>appId==='dart'});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect(controller.submit).toHaveBeenCalledOnce();
    expect((await store.get('rbridge.other.app'))?.phase).toBe('SUBMITTED');
  });

  it('holds V1 before markSubmitted and controller.submit, preserving CLAIMED',async()=>{
    const {store}=await durable(),issue=v1Issue(),controller=ctl(),publish=vi.fn(),hold=vi.fn(async()=>true);
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller,admissionHold:hold});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect((await store.get('rbridge.owner.hold.v1'))?.phase).toBe('CLAIMED');
    expect(hold).toHaveBeenCalledWith(expect.objectContaining({
      appId:'aplall',requestId:'rbridge.owner.hold.v1',jobId:'aplall-original-job',issueNumber:92
    }));
    expect(controller.submit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails closed on unverifiable V1 owner decision without controller effect',async()=>{
    const {store}=await durable(),issue=v1Issue(),controller=ctl(),publish=vi.fn();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store,
      github:{listOpenRequests:async()=>[issue],publishResult:publish},
      controller,admissionHold:async()=>{throw Error('PIN_CHANGED');}});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:1});
    expect((await store.get('rbridge.owner.hold.v1'))?.phase).toBe('CLAIMED');
    expect(controller.submit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
