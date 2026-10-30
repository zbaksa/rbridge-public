import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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
    const published=vi.fn(async()=>{});
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
    const withHold={...TRANSPORT,now,store,github,controller,admissionHold};
    expect(await createRemoteBridgeWorker(withHold).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0});
    expect(holdObserved).toHaveLength(1);
    expect(controller.submit).toHaveBeenCalledOnce();
    expect(await store.get('bridge.keyb-v9-1')).toEqual(before);
    expect(published).not.toHaveBeenCalled();
  });

  it('HOLD: fresh app request remains WAITING without any controller effect',async()=>{
    const store=await durable(),entry=issue('keyb-v9-2',801);
    const published=vi.fn(async()=>{});
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>success(job)),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async(_app:string,job:string)=>success(job)),
    };
    const seen:unknown[]=[];
    const admissionHold=async(value:{appId:string;issueNumber:number;requestSha256:string})=>{
      seen.push(value);
      return value.appId==='games2d'&&value.issueNumber===801&&/^[a-f0-9]{64}$/.test(value.requestSha256);
    };
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0,errors:0});
    expect(seen).toHaveLength(1);
    expect(controller.submit).not.toHaveBeenCalled();
    expect((await store.get('bridge.keyb-v9-2'))?.phase).toBe('WAITING');
    expect(published).not.toHaveBeenCalled();
  });

  it('HOLD: inability to verify owner policy fails closed without controller or Issue mutation',async()=>{
    const store=await durable(),entry=issue('keyb-v9-3',802);
    const published=vi.fn(async()=>{});
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>success(job)),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async(_app:string,job:string)=>success(job)),
    };
    const admissionHold=vi.fn(async():Promise<boolean>=>{throw Error('OWNER_HOLD_PROOF_UNAVAILABLE');});
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0,errors:1});
    expect(admissionHold).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
    expect((await store.get('bridge.keyb-v9-3'))?.phase).toBe('WAITING');
    expect(published).not.toHaveBeenCalled();
  });

  it('HOLD: an explicit not-held decision preserves ordinary APP_RUN execution',async()=>{
    const store=await durable(),entry=issue('keyb-v9-4',803);
    const published=vi.fn(async()=>{});
    const controller={
      submit:vi.fn(async(_app:string,job:string)=>success(job)),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async(_app:string,job:string)=>success(job)),
    };
    const admissionHold=vi.fn(async():Promise<boolean>=>false);
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold}).runOnce())
      .toMatchObject({pending:0,published:1,blocked:0,errors:0});
    expect(admissionHold).toHaveBeenCalledOnce();
    expect(controller.submit).toHaveBeenCalledOnce();
    expect((await store.get('bridge.keyb-v9-4'))?.phase).toBe('PUBLISHED');
    expect(published).toHaveBeenCalledOnce();
  });

  it('RED: existing unscoped historic WAITING cannot be published CLOSED before app owner HOLD',async()=>{
    const store=await durable(),entry=issue('keyb-v9-5',804),published=vi.fn(async()=>{});
    const controller={
      submit:vi.fn(async()=>({state:'BLOCKED',reason:'application already has an active or uncertain writer'})),
      status:vi.fn(async()=>({state:'UNCERTAIN'})),
      result:vi.fn(async()=>success('keyb-v9-5')),
    };
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller}).runOnce();
    const path=join(roots.at(-1)!,'bridge.keyb-v9-5.json');
    const scoped=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
    expect(scoped.phase).toBe('WAITING');
    expect(scoped.scopeSha256).toMatch(/^[a-f0-9]{64}$/);
    delete scoped.scopeSha256; // model the authentic 9/9 unscoped legacy store records
    await writeFile(path,JSON.stringify(scoped)+'\n');
    const preimage=await readFile(path,'utf8');
    const admissionHold=vi.fn(async()=>true);
    clock=LATER;
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0});
    expect(published).not.toHaveBeenCalled();
    expect(controller.submit).toHaveBeenCalledOnce();
    expect(await readFile(path,'utf8')).toBe(preimage);
    expect((await store.get('bridge.keyb-v9-5'))?.scopeSha256).toBeUndefined();
  });

  it('RED: owner HOLD must intercept legacy V1 APP_RUN before its controller submission',async()=>{
    const store=await durable(),requestId='bridge.legacy-v1-1';
    const old={
      number:805,title:'[COCWIN BRIDGE REQUEST] '+requestId,
      authorLogin:'bridge-owner',url:'https://github.com/example/rbridge-control/issues/805',
      body:JSON.stringify({
        schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId,
        createdAt:'2026-10-26T10:00:00.000Z',expiresAt:'2026-10-26T10:10:00.000Z',
        appId:'editor',jobId:'legacy-v1-1',operation:'RUN',
        payload:{tool:'probe',cwd:'/home/editor/backend',args:[],timeout_ms:30000,max_bytes:65536},
      }),
    };
    const published=vi.fn(async()=>{}),held=vi.fn(async()=>true);
    const controller={
      submit:vi.fn(async()=>({state:'SUCCEEDED'})),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async()=>success('legacy-v1-1')),
    };
    const github={listOpenRequests:async()=>[old],publishResult:published};
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold:held}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0,errors:0});
    expect(held).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect((await store.get(requestId))?.phase).toBe('CLAIMED');
  });

  it('unscoped legacy WAITING is preserved even with no HOLD adapter configured',async()=>{
    const store=await durable(),entry=issue('keyb-v9-6',806),published=vi.fn(async()=>{});
    const controller={
      submit:vi.fn(async()=>({state:'BLOCKED',reason:'application already has an active or uncertain writer'})),
      status:vi.fn(async()=>({state:'UNCERTAIN'})),
      result:vi.fn(async()=>success('keyb-v9-6')),
    };
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller}).runOnce();
    const path=join(roots.at(-1)!,'bridge.keyb-v9-6.json');
    const record=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
    expect(record.phase).toBe('WAITING');
    delete record.scopeSha256;
    await writeFile(path,JSON.stringify(record)+'\n');
    const original=await readFile(path,'utf8');
    clock=LATER;
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0,errors:1});
    expect(controller.submit).toHaveBeenCalledOnce();
    expect(published).not.toHaveBeenCalled();
    expect(await readFile(path,'utf8')).toBe(original);
  });

  it('legacy V1 HOLD verification exception preserves CLAIMED and cannot call the controller',async()=>{
    const store=await durable(),requestId='bridge.legacy-v1-2';
    const payload={tool:'probe',cwd:'/home/editor/backend',args:[],timeout_ms:30000,max_bytes:65536};
    const entry={
      number:807,title:'[COCWIN BRIDGE REQUEST] '+requestId,authorLogin:'bridge-owner',
      url:'https://github.com/example/rbridge-control/issues/807',
      body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId,
        createdAt:'2026-10-26T10:00:00.000Z',expiresAt:'2026-10-26T10:10:00.000Z',
        appId:'editor',jobId:'legacy-v1-2',operation:'RUN',payload}),
    };
    const published=vi.fn(async()=>{}),controller={
      submit:vi.fn(async()=>({state:'SUCCEEDED'})),
      status:vi.fn(async()=>({state:'SUCCEEDED'})),
      result:vi.fn(async()=>success('legacy-v1-2')),
    };
    const admissionHold=vi.fn(async():Promise<boolean>=>{throw Error('OWNER_POLICY_UNAVAILABLE');});
    const github={listOpenRequests:async()=>[entry],publishResult:published};
    expect(await createRemoteBridgeWorker({...TRANSPORT,now,store,github,controller,admissionHold}).runOnce())
      .toMatchObject({pending:1,published:0,blocked:0,errors:1});
    expect(admissionHold).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect((await store.get(requestId))?.phase).toBe('CLAIMED');
  });

});
