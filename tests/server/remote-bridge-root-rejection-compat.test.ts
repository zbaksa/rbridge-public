import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';

const transport={repository:'example/rbridge-control',authorLogin:'bridge-owner',
  instanceId:'root-compat-test'} as const;
const clock=()=>new Date('2026-10-28T20:30:00.000Z');
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function store(){
  const dir=await mkdtemp(join(tmpdir(),'rbridge-root-rejection-'));
  dirs.push(dir);return createRemoteBridgeStore(dir,clock);
}
function request(number:number,requestId='bridge.root.blocked.1'){
  const job='root-receipt-check';
  return {number,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,
    authorLogin:transport.authorLogin,url:`https://github.com/example/rbridge-control/issues/${number}`,
    body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,
      createdAt:'2026-10-28T20:25:00.000Z',expiresAt:'2026-10-28T20:35:00.000Z',
      operation:{kind:'APP_RUN',appId:'rbridge',jobId:job,
        payload:{tool:'probe',cwd:'/home/rbridge/backend',args:[],
          timeout_ms:30000,max_bytes:65536}}})};
}
const empty=()=>vi.fn(async()=>({state:'UNKNOWN'}));

describe('COCWIN privileged maintenance result compatibility',()=>{
  it('retains a definitive denial reason on durable replay without another submit',async()=>{
    const durable=await store(),outputs:Record<string,unknown>[]=[];
    const denial={schema:'COCWIN_APP_EXECUTION_STATUS_V1',
      app:'rbridge',job:'root-receipt-check',state:'BLOCKED',
      reason:'APP_EXECUTION_IDENTITY_UNAVAILABLE'};
    const firstSubmit=vi.fn(async()=>denial);
    const first=createRemoteBridgeWorker({...transport,now:clock,store:durable,
      github:{listOpenRequests:async()=>[request(41)],
        publishResult:async(_n,value)=>{outputs.push(value as Record<string,unknown>);}},
      controller:{submit:firstSubmit,status:empty(),result:empty()}});
    expect(await first.runOnce()).toMatchObject({published:1,blocked:1,errors:0});
    expect(firstSubmit).toHaveBeenCalledOnce();
    expect(outputs[0]).toMatchObject({status:'BLOCKED',reason:denial.reason});
    const resubmit=vi.fn(),restat=vi.fn(),reresult=vi.fn();
    const replay=createRemoteBridgeWorker({...transport,now:clock,store:durable,
      github:{listOpenRequests:async()=>[request(42)],
        publishResult:async(_n,value)=>{outputs.push(value as Record<string,unknown>);}},
      controller:{submit:resubmit,status:restat,result:reresult}});
    expect(await replay.runOnce()).toMatchObject({published:1,blocked:1,errors:0});
    expect(resubmit).not.toHaveBeenCalled();
    expect(restat).not.toHaveBeenCalled();
    expect(reresult).not.toHaveBeenCalled();
    expect(outputs[1]).toMatchObject({status:'BLOCKED',issueNumber:42,
      reason:'APP_EXECUTION_IDENTITY_UNAVAILABLE'});
    expect(outputs[1]?.resultSha256).toBe(outputs[0]?.resultSha256);
    expect(outputs[1]?.operationResult).toEqual(outputs[0]?.operationResult);
  });

  it('does not treat an APP_RUN transport PASS as a ROOT receipt PASS',async()=>{
    const durable=await store(),output:Record<string,unknown>[]=[];
    const root={schema:'COCWIN_MAINTENANCE_RECEIPT_V2',
      requestId:'cocwin-maint-v1-fixture-denied',appId:'rbridge',
      status:'BLOCKED',reason:'APP_EXECUTION_IDENTITY_UNAVAILABLE',
      executionStarted:false};
    const appResult={schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'rbridge',
      job:'root-receipt-check',state:'SUCCEEDED',returncode:0,
      stdout:JSON.stringify(root)+'\n',stderr:'',timed_out:false,truncated:false};
    const worker=createRemoteBridgeWorker({...transport,now:clock,store:durable,
      github:{listOpenRequests:async()=>[request(43,'bridge.root.nested.1')],
        publishResult:async(_n,v)=>{output.push(v as Record<string,unknown>);}},
      controller:{submit:async()=>({state:'SUCCEEDED'}),status:empty(),
        result:async()=>appResult}});
    expect(await worker.runOnce()).toMatchObject({published:1,errors:0});
    expect(output[0]?.status).toBe('PASS'); // transport / APP_RUN ONLY
    const nested=output[0]?.operationResult as Record<string,unknown>;
    expect(nested.state).toBe('SUCCEEDED');
    const receipt=JSON.parse(String(nested.stdout)) as Record<string,unknown>;
    expect(receipt.status).toBe('BLOCKED'); // ROOT outcome remains independent
    expect(receipt.executionStarted).toBe(false);
    expect(output[0]).not.toHaveProperty('rootQualification');
  });
});
