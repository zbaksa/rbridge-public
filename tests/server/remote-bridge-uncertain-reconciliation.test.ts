import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const roots:string[]=[];
const TRANSPORT={repository:'example/rbridge-control',authorLogin:'bridge-owner'} as const;
const NOW=()=>new Date('2026-09-27T12:00:00.000Z');

afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function store(){const p=await mkdtemp(join(tmpdir(),'rbridge-uncertain-'));roots.push(p);return createRemoteBridgeStore(p,NOW);}

function v1Issue(){
  return {number:1,title:'[COCWIN BRIDGE REQUEST] rbridge.uncertain.v1',authorLogin:TRANSPORT.authorLogin,url:'https://github.com/example/rbridge-control/issues/1',body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId:'rbridge.uncertain.v1',createdAt:'2026-09-27T11:59:00.000Z',expiresAt:'2026-09-27T12:20:00.000Z',appId:'rbridge',jobId:'uncertain-v1',operation:'RUN',payload:{tool:'node',cwd:'/home/rbridge/backend',args:['--version'],timeout_ms:30000,max_bytes:65536}})};
}
function v2Issue(){
  return {number:2,title:'[COCWIN BRIDGE REQUEST] rbridge.uncertain.v2',authorLogin:TRANSPORT.authorLogin,url:'https://github.com/example/rbridge-control/issues/2',body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:'rbridge.uncertain.v2',createdAt:'2026-09-27T11:59:00.000Z',expiresAt:'2026-09-27T12:20:00.000Z',operation:{kind:'APP_RUN',appId:'rbridge',jobId:'uncertain-v2',payload:{tool:'node',cwd:'/home/rbridge/backend',args:['--version'],timeout_ms:30000,max_bytes:65536}}})};
}

describe('durable APP_RUN UNCERTAIN reconciliation',()=>{
  it('keeps legacy V1 UNCERTAIN submitted and pending',async()=>{
    const durable=await store(),publish=vi.fn(),result=vi.fn();
    const worker=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store:durable,github:{listOpenRequests:async()=>[v1Issue()],publishResult:publish},controller:{submit:async()=>({state:'UNCERTAIN',reason:'launcher acknowledgement unavailable'}),status:vi.fn(),result}});
    expect(await worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect(publish).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    expect((await durable.get('rbridge.uncertain.v1'))?.phase).toBe('SUBMITTED');
  });

  it('keeps V2 UNCERTAIN pending until status becomes terminal without resubmit',async()=>{
    const durable=await store(),publish=vi.fn(),result=vi.fn();
    const first=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store:durable,github:{listOpenRequests:async()=>[v2Issue()],publishResult:publish},controller:{submit:async()=>({state:'UNCERTAIN',reason:'launcher acknowledgement unavailable'}),status:vi.fn(),result}});
    expect(await first.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect((await durable.get('rbridge.uncertain.v2'))?.phase).toBe('SUBMITTED');

    const submit=vi.fn();
    const status=vi.fn()
      .mockResolvedValueOnce({state:'UNCERTAIN',reason:'launcher acknowledgement unavailable'})
      .mockResolvedValueOnce({state:'FAILED',reason:'monitor launch was not observed after safety grace',returncode:75,timed_out:false,truncated:false});
    const terminal=vi.fn(async()=>({state:'FAILED',reason:'monitor launch was not observed after safety grace',returncode:75,stdout:'',stderr:'monitor launch was not observed',timed_out:false,truncated:false}));
    const resumed=createRemoteBridgeWorker({...TRANSPORT,now:NOW,store:durable,github:{listOpenRequests:async()=>[v2Issue()],publishResult:publish},controller:{submit,status,result:terminal}});

    expect(await resumed.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:0});
    expect(submit).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();

    expect(await resumed.runOnce()).toEqual({seen:1,pending:0,published:1,blocked:0,errors:0});
    expect(submit).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![1]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:'rbridge.uncertain.v2',status:'FAIL',operationResult:{state:'FAILED',reason:'monitor launch was not observed after safety grace'}});
    expect((await durable.get('rbridge.uncertain.v2'))?.phase).toBe('PUBLISHED');
  });
});
