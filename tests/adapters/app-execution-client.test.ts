import { describe, expect, it } from 'vitest';
import { createAppExecutionClient } from '../../src/adapters/appExecutionClient.js';

function outer(stdout:unknown, status:'PASS'|'FAIL'='PASS', rc=0):string{
  return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status,rc,stdout:JSON.stringify(stdout)+'\n',stderr:''});
}

const submitPayload={
  tool:'probe',cwd:'/home/bai/backend',args:[],timeout_ms:30_000,max_bytes:262_144,
};

describe('COCWIN app execution client',()=>{
  it('submits only the fixed app-execution protocol shape',async()=>{
    const seen:unknown[]=[];
    const client=createAppExecutionClient({exchange:async(request)=>{seen.push(request);return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-1',state:'QUEUED'});}});
    const out=await client.submit('bai','wc5-job-1',submitPayload);
    expect(out).toMatchObject({app:'bai',job:'wc5-job-1',state:'QUEUED'});
    expect(seen).toEqual([{app:'bai',action:'app-submit',arg:'wc5-job-1',payload:submitPayload}]);
  });

  it('rejects unsafe app job tool cwd and unknown payload fields before exchange',async()=>{
    let called=false;
    const client=createAppExecutionClient({exchange:async()=>{called=true;return outer({state:'QUEUED'});}});
    for(const [app,job,payload] of [
      ['Bad App','wc5-job-1',submitPayload],
      ['bai','../job',submitPayload],
      ['bai','wc5-job-1',{...submitPayload,tool:'bash'}],
      ['bai','wc5-job-1',{...submitPayload,cwd:'../escape'}],
      ['bai','wc5-job-1',{...submitPayload,token:'secret'}],
    ] as const){
      await expect(client.submit(app,job,payload)).rejects.toThrow(/APP_EXECUTION_/);
    }
    expect(called).toBe(false);
  });

  it('polls queued and running states until a durable success result exists',async()=>{
    const actions:string[]=[];let statusCount=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      actions.push(request.action);
      if(request.action==='app-submit')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-1',state:'QUEUED'});
      if(request.action==='app-status'){
        statusCount+=1;return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-1',state:statusCount===1?'RUNNING':'SUCCEEDED',returncode:0});
      }
      return outer({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'wc5-job-1',state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:''});
    }});
    const out=await client.run('bai','wc5-job-1',submitPayload,{deadlineMs:5_000});
    expect(out).toMatchObject({state:'SUCCEEDED',stdout:'ok',returncode:0});
    expect(actions).toEqual(['app-submit','app-status','app-status','app-result']);
  });

  it('keeps failed or uncertain target execution non-PASS',async()=>{
    for(const terminal of ['FAILED','UNCERTAIN'] as const){
      const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
        if(request.action==='app-submit')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-2',state:'QUEUED'});
        if(request.action==='app-status')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-2',state:terminal,reason:'target did not prove success'},terminal==='UNCERTAIN'?'FAIL':'PASS',terminal==='UNCERTAIN'?75:0);
        return outer({state:terminal},'FAIL',75);
      }});
      await expect(client.run('bai','wc5-job-2',submitPayload,{deadlineMs:1_000})).rejects.toThrow(terminal==='FAILED'?'APP_EXECUTION_FAILED':'APP_EXECUTION_UNCERTAIN');
    }
  });

  it('retries only the same idempotent submit when the broker briefly blocks it',async()=>{
    const actions:string[]=[];let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      actions.push(request.action);
      if(request.action==='app-submit'){
        submits+=1;
        if(submits===1)return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'application job state is busy'});
        return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-retry',state:'QUEUED'});
      }
      if(request.action==='app-status')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-retry',state:'SUCCEEDED',returncode:0});
      return outer({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'wc5-job-retry',state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:''});
    }});
    const out=await client.run('bai','wc5-job-retry',submitPayload,{deadlineMs:5_000});
    expect(out).toMatchObject({state:'SUCCEEDED',stdout:'ok'});
    expect(actions).toEqual(['app-submit','app-submit','app-status','app-result']);
  });

  it('does not retry an active or uncertain writer conflict',async()=>{
    let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async()=>{
      submits+=1;
      return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'application already has an active or uncertain writer'});
    }});
    await expect(client.submit('bai','wc5-job-active-writer',submitPayload)).rejects.toThrow('APP_EXECUTION_BROKER_REJECTED:application already has an active or uncertain writer');
    expect(submits).toBe(1);
  });

  it('recovers when the first idempotent submit response is lost in transport',async()=>{
    let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      if(request.action==='app-submit'){
        submits+=1;
        if(submits===1)throw new Error('ECONNRESET');
        return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-lost',state:'SUCCEEDED',returncode:0});
      }
      return outer({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'wc5-job-lost',state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:''});
    }});
    const out=await client.run('bai','wc5-job-lost',submitPayload,{deadlineMs:5_000});
    expect(out).toMatchObject({state:'SUCCEEDED',stdout:'ok'});
    expect(submits).toBe(2);
  });

  it('waits through bounded transient job-state contention beyond three submit attempts',async()=>{
    let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      if(request.action==='app-submit'){
        submits+=1;
        if(submits<=4)return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'application job state is busy'});
        return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-contention',state:'QUEUED'});
      }
      if(request.action==='app-status')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-contention',state:'SUCCEEDED',returncode:0});
      return outer({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'wc5-job-contention',state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:''});
    }});
    const out=await client.run('bai','wc5-job-contention',submitPayload,{deadlineMs:5_000});
    expect(out).toMatchObject({state:'SUCCEEDED',stdout:'ok'});
    expect(submits).toBe(5);
  });

  it('treats transient broker EAGAIN as bounded idempotent submit contention',async()=>{
    let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      if(request.action==='app-submit'){
        submits+=1;
        if(submits<=4)return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'[Errno 11] Resource temporarily unavailable'});
        return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-eagain',state:'QUEUED'});
      }
      if(request.action==='app-status')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-eagain',state:'SUCCEEDED',returncode:0});
      return outer({schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'wc5-job-eagain',state:'SUCCEEDED',returncode:0,stdout:'ok',stderr:''});
    }});
    const out=await client.run('bai','wc5-job-eagain',submitPayload,{deadlineMs:5_000});
    expect(out).toMatchObject({state:'SUCCEEDED',stdout:'ok'});
    expect(submits).toBe(5);
  });

  it('does not retry a definitive broker rejection',async()=>{
    let calls=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async()=>{
      calls+=1;
      return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'CONTROLLER_PEER_NOT_AUTHORIZED'});
    }});
    await expect(client.submit('bai','wc5-job-reject',submitPayload)).rejects.toThrow('APP_EXECUTION_BROKER_REJECTED:CONTROLLER_PEER_NOT_AUTHORIZED');
    expect(calls).toBe(1);
  });

  it('times out locally without inventing cancellation or success',async()=>{
    const client=createAppExecutionClient({pollIntervalMs:0,now:(()=>{let n=0;return()=>new Date(n++<2?0:10_000);})(),exchange:async(request)=>{
      if(request.action==='app-submit')return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-3',state:'QUEUED'});
      return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'wc5-job-3',state:'RUNNING'});
    }});
    await expect(client.run('bai','wc5-job-3',submitPayload,{deadlineMs:1_000})).rejects.toThrow('APP_EXECUTION_DEADLINE_EXCEEDED');
  });
  it('accepts only a bounded final OpenCode prompt above the generic per-arg limit',async()=>{
    let calls=0;
    const client=createAppExecutionClient({exchange:async(request)=>{calls+=1;return outer({schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:request.app,job:request.arg,state:'QUEUED'});}});
    const fixed=['run','--auto','--format','json','--dir','/home/cocwin/backend/.cocwin-worktrees/canary','--model','ollama/qwen3-coder:30b'];
    const prompt='x'.repeat(18_463);
    await expect(client.submit('cocwin','wc5-opencode-prompt',{tool:'opencode',cwd:'/home/cocwin/backend/.cocwin-worktrees/canary',args:[...fixed,prompt],timeout_ms:300_000,max_bytes:262_144})).resolves.toMatchObject({state:'QUEUED'});
    expect(calls).toBe(1);
    await expect(client.submit('cocwin','wc5-opencode-too-big',{tool:'opencode',cwd:'/home/cocwin/backend/.cocwin-worktrees/canary',args:[...fixed,'x'.repeat(24*1024+1)],timeout_ms:300_000,max_bytes:262_144})).rejects.toThrow('APP_EXECUTION_ARGS_INVALID');
    await expect(client.submit('cocwin','wc5-opencode-nonfinal',{tool:'opencode',cwd:'/home/cocwin/backend/.cocwin-worktrees/canary',args:['x'.repeat(8193),'prompt'],timeout_ms:300_000,max_bytes:262_144})).rejects.toThrow('APP_EXECUTION_ARGS_INVALID');
    await expect(client.submit('cocwin','wc5-git-oversize',{tool:'git',cwd:'/home/cocwin/backend/.cocwin-worktrees/canary',args:['x'.repeat(8193)],timeout_ms:300_000,max_bytes:262_144})).rejects.toThrow('APP_EXECUTION_ARGS_INVALID');
  });

});


describe('app-execution durable read contention',()=>{
  const job='wc5-read-lock';
  const payload={...submitPayload,cwd:'/home/cocwin/backend'};
  const locked=(error='[Errno 11] Resource temporarily unavailable')=>JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error});
  it.each(['app-status','app-result'] as const)('recovers %s contention without submitting the task again',async(action)=>{
    const seen:Array<{app:string;action:string;arg:string;payload:Record<string,unknown>}>=[];
    let blocked=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      seen.push(request);
      if(request.action===action&&blocked++<4)return locked();
      if(request.action==='app-submit')return outer({app:'cocwin',job,state:action==='app-status'?'QUEUED':'SUCCEEDED'});
      return outer({app:'cocwin',job,state:'SUCCEEDED',stdout:'durable output',returncode:0});
    }});
    await expect(client.run('cocwin',job,payload,{deadlineMs:5_000})).resolves.toMatchObject({state:'SUCCEEDED',stdout:'durable output'});
    expect(seen.filter(r=>r.action==='app-submit')).toEqual([{app:'cocwin',action:'app-submit',arg:job,payload}]);
    expect(seen.every(r=>r.app==='cocwin'&&r.arg===job)).toBe(true);
    expect(seen.filter(r=>r.action===action)).toHaveLength(5);
    expect(seen.filter(r=>r.action!=='app-submit').every(r=>Object.keys(r.payload).length===0)).toBe(true);
  });

  it.each(['status','result'] as const)('recovers standalone %s reads through brief job-state contention',async(method)=>{
    let reads=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      expect(request.action).toBe('app-'+method);
      if(++reads<3)return locked('application job state is busy');
      return outer({app:'cocwin',job,state:'SUCCEEDED',stdout:'durable'});
    }});
    await expect(client[method]('cocwin',job)).resolves.toMatchObject({state:'SUCCEEDED'});
    expect(reads).toBe(3);
  });

  it.each(['status','result'] as const)('bounds persistent %s contention and preserves its rejection',async(method)=>{
    let reads=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async()=>{reads+=1;return locked();}});
    await expect(client[method]('cocwin',job)).rejects.toThrow('APP_EXECUTION_BROKER_REJECTED:[Errno 11] Resource temporarily unavailable');
    expect(reads).toBe(3);
  });

  it.each(['app-status','app-result'] as const)('does not retry a permanent %s denial',async(action)=>{
    let reads=0;let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async(request)=>{
      if(request.action==='app-submit'){submits+=1;return outer({app:'cocwin',job,state:action==='app-status'?'QUEUED':'SUCCEEDED'});}
      reads+=1;return locked('CONTROLLER_PEER_NOT_AUTHORIZED');
    }});
    await expect(client.run('cocwin',job,payload,{deadlineMs:5_000})).rejects.toThrow('APP_EXECUTION_BROKER_REJECTED:CONTROLLER_PEER_NOT_AUTHORIZED');
    expect(submits).toBe(1);expect(reads).toBe(1);
  });

  it.each(['app-status','app-result'] as const)('stops %s retries at the run deadline without restarting work',async(action)=>{
    let clock=0;let reads=0;let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,now:()=>new Date(clock),exchange:async(request)=>{
      if(request.action==='app-submit'){submits+=1;return outer({app:'cocwin',job,state:action==='app-status'?'QUEUED':'SUCCEEDED'});}
      reads+=1;clock=50;return locked();
    }});
    await expect(client.run('cocwin',job,payload,{deadlineMs:50})).rejects.toThrow('APP_EXECUTION_DEADLINE_EXCEEDED');
    expect(reads).toBe(1);expect(submits).toBe(1);
  });

  it('does not retry malformed or mismatched read responses',async()=>{
    for(const reply of ['not-json',outer({app:'other',job,state:'SUCCEEDED'})]){
      let reads=0;
      const client=createAppExecutionClient({pollIntervalMs:0,exchange:async()=>{reads+=1;return reply;}});
      await expect(client.result('cocwin',job)).rejects.toThrow(/APP_EXECUTION_(BROKER_BAD_JSON|RESULT_IDENTITY_INVALID)/);
      expect(reads).toBe(1);
    }
  });
});

describe('app-execution incomplete failed output',()=>{
  it.each(['timed_out','truncated'] as const)('keeps a FAILED job with %s evidence uncertain',async(flag)=>{
    const client=createAppExecutionClient({pollIntervalMs:0,exchange:async()=>outer({app:'cocwin',job:'wc5-incomplete',state:'FAILED',returncode:75,[flag]:true})});
    await expect(client.run('cocwin','wc5-incomplete',{...submitPayload,cwd:'/home/cocwin/backend'},{deadlineMs:1000})).rejects.toThrow('APP_EXECUTION_UNCERTAIN');
  });
  it('bounds run read contention even when the injected clock does not advance',async()=>{
    let reads=0;let submits=0;
    const client=createAppExecutionClient({pollIntervalMs:0,now:()=>new Date(0),exchange:async(request)=>{
      if(request.action==='app-submit'){submits+=1;return outer({app:'cocwin',job:'wc5-limit',state:'SUCCEEDED'});}
      reads+=1;if(reads>120)throw new Error('UNBOUNDED_READ_RETRY');
      return JSON.stringify({schema:'ATF_CONTROLLER_BROKER_RESPONSE_V1',status:'BLOCKED',error:'[Errno 11] Resource temporarily unavailable'});
    }});
    await expect(client.run('cocwin','wc5-limit',{...submitPayload,cwd:'/home/cocwin/backend'},{deadlineMs:5000})).rejects.toThrow('APP_EXECUTION_BROKER_REJECTED:[Errno 11] Resource temporarily unavailable');
    expect(submits).toBe(1);expect(reads).toBe(120);
  });
});
