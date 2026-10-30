import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const TRANSPORT={repository:'example/rbridge-control',authorLogin:'bridge-owner',instanceId:'rbridge-waiting-test'} as const;
const roots:string[]=[];
const START=new Date('2026-10-26T10:05:00.000Z');
const LATER=new Date('2026-10-26T10:15:00.000Z');
let clock=START;
const now=()=>clock;
afterEach(async()=>{clock=START;await Promise.all(roots.splice(0).map(x=>rm(x,{recursive:true,force:true})));});
async function durable(){const dir=await mkdtemp(join(tmpdir(),'bridge-waiting-'));roots.push(dir);return createRemoteBridgeStore(dir,now);}
function issue(job='keyb-v9-1',number=800){
  const requestId='bridge.'+job;
  return {number,title:'[COCWIN BRIDGE REQUEST] '+requestId,authorLogin:'bridge-owner',
    url:'https://github.com/example/rbridge-control/issues/'+number,
    body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,
      createdAt:'2026-10-26T10:00:00.000Z',expiresAt:'2026-10-26T10:10:00.000Z',
      operation:{kind:'APP_RUN',appId:'games2d',jobId:job,
        payload:{tool:'probe',cwd:'/home/games2d/backend',args:[],timeout_ms:30000,max_bytes:262144}}})};
}
const success=(job:string)=>({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'games2d',job,
  state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:'',timed_out:false,truncated:false});
function run(store:ReturnType<typeof createRemoteBridgeStore>,controller:{
    submit:(app:string,job:string,payload:unknown)=>Promise<Record<string,unknown>>;
    status:(app:string,job:string)=>Promise<Record<string,unknown>>;
    result:(app:string,job:string)=>Promise<Record<string,unknown>>;
  },publishResult:(issue:number,result:unknown)=>Promise<void>,issues=[issue()]){
  return createRemoteBridgeWorker({...TRANSPORT,now,store,github:{listOpenRequests:async()=>issues,publishResult},controller}).runOnce();
}

describe('APP_RUN occupied-writer durable admission',()=>{
  it('holds a second Games2D job in WAITING then executes it once after the first finishes, even past intake TTL',async()=>{
    const store=await durable(),published:unknown[]=[],submitted:string[]=[];
    const accepted=new Set<string>();let holder='dart-1';
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>{
        submitted.push(job);
        if(holder&&holder!==job)return {state:'BLOCKED',reason:'application already has an active or uncertain writer'};
        if(!accepted.has(job)){accepted.add(job);holder=job;}
        return {state:'RUNNING'};
      }),
      status:vi.fn(async(_app:string,job:string)=>({state:holder===job?'RUNNING':'SUCCEEDED'})),
      result:vi.fn(async(_app:string,job:string)=>success(job)),
    };
    const publish=async(_n:number,v:unknown)=>{published.push(v);};
    expect(await run(store,controller,publish)).toMatchObject({pending:1,published:0,blocked:0});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('WAITING');
    expect(accepted.size).toBe(0);
    clock=LATER; // intake TTL expired; a prior durable claim is still valid
    holder='';
    expect(await run(store,controller,publish)).toMatchObject({pending:1,published:0,blocked:0});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('SUBMITTED');
    expect(accepted.size).toBe(1);
    expect(await run(store,controller,publish)).toMatchObject({pending:1,published:0,blocked:0});
    holder='';
    expect(await run(store,controller,publish)).toMatchObject({published:1,blocked:0});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({status:'PASS'});
    expect(accepted.size).toBe(1);
    expect(submitted).toEqual(['keyb-v9-1','keyb-v9-1']);
  });

  it('recovers ambiguous submit acknowledgement by idempotent same-job replay without a second effect',async()=>{
    const store=await durable(),published:unknown[]=[],executed=new Set<string>();
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>{
        if(!executed.has(job)){executed.add(job);throw new Error('transport lost after commit');}
        return {state:'SUCCEEDED'};
      }),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async(_app:string,job:string)=>success(job)),
    };
    const publish=async(_n:number,v:unknown)=>{published.push(v);};
    const first=await run(store,controller,publish);
    expect(first).toMatchObject({pending:1,errors:1,published:0});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('WAITING');
    clock=LATER; // simulate a restarted Bridge after expiry
    const second=await run(store,controller,publish);
    expect(second).toMatchObject({pending:0,errors:0,published:1,blocked:0});
    expect(executed.size).toBe(1);
    expect(controller.submit).toHaveBeenCalledTimes(2);
    expect(published[0]).toMatchObject({status:'PASS'});
  });

  it('does not queue a definitive permission denial and does not resubmit it',async()=>{
    const store=await durable(),published:unknown[]=[];
    const controller={
      submit:vi.fn(async()=>({state:'BLOCKED',reason:'CONTROLLER_PEER_NOT_AUTHORIZED'})),
      status:vi.fn(),result:vi.fn(),
    };
    const publish=async(_n:number,v:unknown)=>{published.push(v);};
    expect(await run(store,controller,publish)).toMatchObject({published:1,blocked:1,pending:0});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('PUBLISHED');
    expect(published[0]).toMatchObject({status:'BLOCKED',reason:'CONTROLLER_PEER_NOT_AUTHORIZED'});
    await run(store,controller,publish);
    expect(controller.submit).toHaveBeenCalledOnce();
  });

  it('rejects a fresh expired request and never calls the controller',async()=>{
    const store=await durable(),controller={submit:vi.fn(),status:vi.fn(),result:vi.fn()},published:unknown[]=[];
    clock=LATER;
    expect(await run(store,controller,async(_n,v)=>{published.push(v);})).toMatchObject({published:1,blocked:1});
    expect(controller.submit).not.toHaveBeenCalled();
    expect(published[0]).toMatchObject({status:'BLOCKED',reason:'REMOTE_BRIDGE_V2_REQUEST_EXPIRED'});
  });

  it('does not let a changed expired request steal a prior durable WAITING identity',async()=>{
    const store=await durable(),published:unknown[]=[];
    const controller={
      submit:vi.fn(async()=>({state:'BLOCKED',reason:'application already has an active or uncertain writer'})),
      status:vi.fn(),result:vi.fn(),
    };
    await run(store,controller,async(_n,v)=>{published.push(v);});
    clock=LATER;
    const tampered=issue();const raw=JSON.parse(tampered.body);
    raw.operation.payload.args=['changed'];
    tampered.body=JSON.stringify(raw);
    expect(await run(store,controller,async(_n,v)=>{published.push(v);},[tampered])).toMatchObject({blocked:1});
    expect(published.at(-1)).toMatchObject({status:'BLOCKED',reason:'REMOTE_BRIDGE_V2_REQUEST_EXPIRED'});
    expect((await store.get('bridge.keyb-v9-1'))?.phase).toBe('WAITING');
    expect(controller.submit).toHaveBeenCalledOnce();
  });
  it('RED: a verified app-scoped owner HOLD must prevent stale WAITING dispatch after the original writer clears',async()=>{
    const store=await durable(),old=issue(),originalJob='keyb-v9-1';
    const published=vi.fn(async(_issue:number,_value:unknown)=>{});
    let writerBusy=true;
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>writerBusy
        ?{state:'BLOCKED',reason:'application already has an active or uncertain writer'}
        :{state:'RUNNING',job}),
      status:vi.fn(async()=>({state:'RUNNING'})),
      result:vi.fn(async()=>success(originalJob)),
    };
    const github={listOpenRequests:async()=>[old],publishResult:published};
    // Baseline: genuine durable WAITING was accepted while the existing writer was uncertain.
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0});
    const before=await store.get('bridge.keyb-v9-1');
    expect(before).toMatchObject({phase:'WAITING',issueNumber:800,jobId:originalJob});
    expect(controller.submit).toHaveBeenCalledOnce();

    // Source-level proposed input: a separately qualified, exact-identity,
    // application-scoped owner policy must hold the original job BEFORE submit.
    // No real owner credentials, ROOT operation or host state are involved.
    const holdObserved:unknown[]=[];
    const admissionHold=async(value:{
      appId:string;requestId:string;jobId:string;requestSha256:string;issueNumber:number
    }):Promise<boolean>=>{
      holdObserved.push(value);
      return value.appId==='games2d'
        &&value.requestId==='bridge.keyb-v9-1'
        &&value.jobId===originalJob&&value.issueNumber===800
        &&value.requestSha256===before?.requestSha256;
    };
    writerBusy=false;
    clock=LATER; // Original intake TTL has now expired, but the durable claim remains.
    const withHold={...TRANSPORT,now,store,github,controller,admissionHold}
      as unknown as Parameters<typeof createRemoteBridgeWorker>[0];
    expect(await createRemoteBridgeWorker(withHold).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0});
    expect(holdObserved).toHaveLength(1);
    expect(controller.submit).toHaveBeenCalledOnce();
    expect(await store.get('bridge.keyb-v9-1')).toEqual(before);
    expect(published).not.toHaveBeenCalled();
  });

});
