import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';
const TRANSPORT={repository:'example/rbridge-control',authorLogin:'bridge-owner',instanceId:'test-instance'} as const;

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const now=()=>new Date('2026-09-16T18:10:00.000Z');
async function store(){const root=await mkdtemp(join(tmpdir(),'bridge-file-worker-'));roots.push(root);return createRemoteBridgeStore(root,now);}
function issue(number=80){const requestId='bridge.file.1';return {number,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,authorLogin:'bridge-owner',url:`https://github.com/example/rbridge-control/issues/${number}`,body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',operation:{kind:'FILE',action:'READ',target:'/mnt/data/bridge-file-canary.txt',args:{}}})};}
const controller=()=>({submit:vi.fn(),status:vi.fn(),result:vi.fn()});

describe('remote bridge worker FILE routing',()=>{
  it('routes V2 FILE through the file port and durably publishes the result',async()=>{
    const durable=await store(),publish=vi.fn(),execute=vi.fn(async()=>({path:'/mnt/data/bridge-file-canary.txt',text:'ok'})),ctl=controller();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now,store:durable,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:ctl,fileOps:{execute}});
    const out=await worker.runOnce();
    expect(out).toMatchObject({seen:1,pending:0,published:1,blocked:0,errors:0});
    expect(execute).toHaveBeenCalledOnce();
    expect(ctl.submit).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]![1]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:'bridge.file.1',status:'PASS',operationResult:{text:'ok'}});
    expect((await durable.get('bridge.file.1'))?.phase).toBe('PUBLISHED');
  });

  it('replays durable SUBMITTED FILE work through the idempotent file port',async()=>{
    const durable=await store(),crash=vi.fn(async()=>{throw new Error('simulated FILE interruption');});
    const first=createRemoteBridgeWorker({...TRANSPORT,now,store:durable,github:{listOpenRequests:async()=>[issue()],publishResult:vi.fn()},controller:controller(),fileOps:{execute:crash}});
    const firstOut=await first.runOnce();expect(firstOut.errors).toBe(1);expect((await durable.get('bridge.file.1'))?.phase).toBe('SUBMITTED');
    const execute=vi.fn(async()=>({text:'ok'})),publish=vi.fn();
    const second=createRemoteBridgeWorker({...TRANSPORT,now,store:durable,github:{listOpenRequests:async()=>[issue()],publishResult:publish},controller:controller(),fileOps:{execute}});
    await second.runOnce();
    expect(execute).toHaveBeenCalledOnce();expect(publish.mock.calls[0]![1]).toMatchObject({status:'PASS',operationResult:{text:'ok'}});
  });

  it('never repeats a mutating FILE effect after execution succeeds but terminal persistence fails',async()=>{
    const durable=await store(),requestId='bridge.file.append.recovery';
    const appendIssue={number:82,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,authorLogin:TRANSPORT.authorLogin,url:'https://github.com/example/rbridge-control/issues/82',body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',operation:{kind:'FILE',action:'APPEND_TEXT',target:'/mnt/data/recovery.txt',args:{text:'once'}}})};
    let value='',terminalWrites=0;
    const execute=vi.fn(async()=>{value+='once';return {path:'/mnt/data/recovery.txt',appended:true};});
    const unstable={...durable,markTerminal:async(...args:Parameters<typeof durable.markTerminal>)=>{terminalWrites+=1;if(terminalWrites===1)throw new Error('simulated terminal persistence failure');return await durable.markTerminal(...args);}};
    const first=createRemoteBridgeWorker({...TRANSPORT,now,store:unstable,github:{listOpenRequests:async()=>[appendIssue],publishResult:vi.fn()},controller:controller(),fileOps:{execute}});
    const firstOut=await first.runOnce();
    expect(firstOut).toMatchObject({seen:1,pending:1,published:0,errors:1});
    expect(value).toBe('once');expect(execute).toHaveBeenCalledOnce();expect((await durable.get(requestId))?.phase).toBe('SUBMITTED');

    const publish=vi.fn();
    const resumed=createRemoteBridgeWorker({...TRANSPORT,now,store:durable,github:{listOpenRequests:async()=>[appendIssue],publishResult:publish},controller:controller(),fileOps:{execute}});
    const secondOut=await resumed.runOnce();
    expect(secondOut).toMatchObject({seen:1,pending:0,published:1,blocked:0,errors:0});
    expect(value).toBe('once');expect(execute).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![1]).toMatchObject({status:'UNCERTAIN',reason:'REMOTE_BRIDGE_FILE_EFFECT_UNCERTAIN'});
    expect((await durable.get(requestId))?.phase).toBe('PUBLISHED');
  });

});
