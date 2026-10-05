import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {spawn} from 'node:child_process';
import {userInfo} from 'node:os';
import {resolve} from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeMcpSafeServer,resolveRBridgeMcpStdioBinding,type RBridgeMcpCore} from '../../src/server/rbridgeMcpSafe.js';
import {runRBridgeMcpMain} from '../../src/server/rbridgeMcpMain.js';
import {mcpTestPort} from '../fixtures/rbridge-stdio-owner.js';

const env={RBRIDGE_RUNTIME_USER:'bridge-test',RBRIDGE_MCP_PRINCIPAL_ID:'operator-test',RBRIDGE_INSTANCE_ID:'target-test'};
const identity={username:'bridge-test',uid:1027,euid:1027};
const binding=()=>resolveRBridgeMcpStdioBinding(env,identity);
const request={operationId:'health-test',operation:{kind:'HEALTH',action:'STATUS'}};
function receipt(submission:RBridgeOperationSubmissionV1):RBridgeExecutionReceiptV1{
  return {schema:'RBRIDGE_EXECUTION_RECEIPT_V1',operationId:submission.operationId,intentSha256:rbridgeOperationIntentDigest(submission),principalId:submission.principalId,targetInstanceId:submission.targetInstanceId,policy:{schema:'RBRIDGE_POLICY_SNAPSHOT_V1',mode:'SAFE',policyVersion:'test',policySha256:'a'.repeat(64),decision:'ALLOW'},phase:'TERMINAL',outcome:'PASS',cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:[{phase:'CLAIMED',at:'2026-10-04T00:00:00.000Z'},{phase:'AUTHORIZED',at:'2026-10-04T00:00:00.001Z'},{phase:'STARTING',at:'2026-10-04T00:00:00.002Z'},{phase:'RUNNING',at:'2026-10-04T00:00:00.003Z'},{phase:'TERMINAL',at:'2026-10-04T00:00:00.004Z'}],postconditions:[]};
}
async function session(core:Pick<RBridgeMcpCore,'submit'>|undefined,mode:'legacy'|{pin:string}={pin:'2026-07-28'}){
  const [transport,wire]=InMemoryTransport.createLinkedPair();
  const handle=serveStdio(()=>createRBridgeMcpSafeServer({binding:binding(),...(core?{core:mcpTestPort(core.submit)}:{})}),{transport:wire});
  const client=new Client({name:'untrusted-client-name',version:'test'},{versionNegotiation:{mode}});
  await client.connect(transport);
  return {client,async close(){await client.close();await handle.close();}};
}

describe('MCP stdio identity boundary',()=>{
  it('maps the verified OS user to deployment-owned principal and target',()=>{
    expect(binding()).toEqual({authenticatedSubject:'uid:1027',principalId:'operator-test',targetInstanceId:'target-test'});
    expect(Object.isFrozen(binding())).toBe(true);
  });
  it.each([{username:'bridge-test',uid:0},{username:'different',uid:1027},{username:'bridge-test',uid:-1},{username:'bridge-test',uid:1027,euid:0},{username:'bridge-test',uid:1027,euid:1028},{username:'bridge-test',uid:0,euid:1027}])('rejects an unauthorized runtime identity %j',user=>{
    expect(()=>resolveRBridgeMcpStdioBinding(env,user)).toThrow('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  });
  it.each(['RBRIDGE_RUNTIME_USER','RBRIDGE_MCP_PRINCIPAL_ID','RBRIDGE_INSTANCE_ID'] as const)('requires explicit valid configuration for %s',key=>{
    expect(()=>resolveRBridgeMcpStdioBinding({...env,[key]:''},identity)).toThrow();
    expect(()=>resolveRBridgeMcpStdioBinding({...env,[key]:'../other'},identity)).toThrow();
  });
});

describe('MCP SAFE transport and core boundary',()=>{
  it.each(['legacy','modern'] as const)('discovers tools and blocks execution without a durable core (%s)',async era=>{
    const s=await session(undefined,era==='legacy'?'legacy':{pin:'2026-07-28'});
    try{
      expect((await s.client.listTools()).tools.map(t=>t.name).sort()).toEqual(['rbridge_cancel','rbridge_capabilities','rbridge_result','rbridge_status','rbridge_submit']);
      const capabilities=await s.client.callTool({name:'rbridge_capabilities',arguments:{}});
      expect(capabilities.structuredContent).toMatchObject({mode:'SAFE',executionAvailable:false,executionStatus:'BLOCKED',supportedKinds:['HEALTH','FILE','PROCESS','CHUNK']});
      const result=await s.client.callTool({name:'rbridge_submit',arguments:request});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({status:'BLOCKED',reason:'RBRIDGE_MCP_CORE_NOT_CONFIGURED',operationId:'health-test'});
    }finally{await s.close();}
  });
  it('delegates the frozen normalized identity once and keeps client metadata out of authority',async()=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>({status:'RECEIPT' as const,receipt:receipt(submission)}));
    const s=await session({submit});
    try{
      const result=await s.client.callTool({name:'rbridge_submit',arguments:request,_meta:{principalId:'attacker',targetInstanceId:'other'}});
      expect(result.structuredContent).toMatchObject({status:'CORE_RECEIPT',receipt:{principalId:'operator-test',targetInstanceId:'target-test',outcome:'PASS'}});
      expect(submit).toHaveBeenCalledTimes(1);
      const [submission,context,signal]=submit.mock.calls[0]! as unknown as [RBridgeOperationSubmissionV1,unknown,AbortSignal];
      expect(submission).toEqual({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...request,principalId:'operator-test',targetInstanceId:'target-test'});
      expect(context).toEqual({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:'uid:1027',principalId:'operator-test'});
      expect(signal).toBeInstanceOf(AbortSignal);
    }finally{await s.close();}
  });
  it.each([
    {...request,principalId:'attacker'},
    {...request,targetInstanceId:'other'},
    {...request,schema:'other'},
    {...request,operationId:'../bad'},
    {...request,operation:{kind:'APP_RUN',appId:'shell'}},
    {...request,operation:{kind:'PROCESS',action:'START',args:{executable:'/bin/sh'}}},
    {...request,operation:{kind:'FILE',action:'READ',target:'/mnt/data/file',args:{allowedRoots:['/']}}},
    {...request,operation:{kind:'FILE',action:'READ',target:'/mnt/data/../secret',args:{}}},
    {...request,operation:{kind:'HEALTH',action:'STATUS',extra:true}},
    {...request,operation:{kind:'PROCESS',action:'START',args:JSON.parse('{"__proto__":{"polluted":true}}') as object}},
    {...request,operation:{kind:'PROCESS',action:'START',args:{profileId:'node-safe',data:'x'.repeat(65536)}}},
    {...request,operation:{kind:'PROCESS',action:'START',args:{data:Array.from({length:18}).reduce<object>(value=>({child:value}),{})}}},
  ])('rejects unauthorized/invalid arguments without touching the core (%#)',async args=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>({status:'RECEIPT' as const,receipt:receipt(submission)}));const s=await session({submit});
    try{const result=await s.client.callTool({name:'rbridge_submit',arguments:args});expect(result.isError).toBe(true);expect(submit).not.toHaveBeenCalled();}finally{await s.close();}
  });
  it('preserves the same operation ID across retries and changed intent for durable collision handling',async()=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>({status:'RECEIPT' as const,receipt:receipt(submission)}));const s=await session({submit});
    try{
      await s.client.callTool({name:'rbridge_submit',arguments:request});
      await s.client.callTool({name:'rbridge_submit',arguments:request});
      await s.client.callTool({name:'rbridge_submit',arguments:{...request,operation:{kind:'FILE',action:'STAT',target:'/mnt/data/file',args:{}}}});
      const rows=submit.mock.calls.map(c=>c[0]);expect(rows.map(r=>r.operationId)).toEqual(['health-test','health-test','health-test']);
      expect(rbridgeOperationIntentDigest(rows[0])).toBe(rbridgeOperationIntentDigest(rows[1]));
      expect(rbridgeOperationIntentDigest(rows[0])).not.toBe(rbridgeOperationIntentDigest(rows[2]));
    }finally{await s.close();}
  });
  it('returns uncertainty without retrying or leaking a core exception',async()=>{
    const submit=vi.fn(async()=>{throw new Error('private-token-secret');});const s=await session({submit});
    try{const result=await s.client.callTool({name:'rbridge_submit',arguments:request});expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'});expect(JSON.stringify(result)).not.toContain('private-token-secret');expect(submit).toHaveBeenCalledTimes(1);}finally{await s.close();}
  });
  it.each([
    {kind:'PROCESS',action:'START',args:{profileId:'node-safe'}},
    {kind:'PROCESS',action:'STATUS',sessionId:'session-test',args:{}},
    {kind:'CHUNK',action:'GET',transferId:'transfer-test',args:{index:0}},
  ])('maps a SAFE operation without selecting a new identity (%#)',async operation=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>({status:'RECEIPT' as const,receipt:receipt(submission)}));const s=await session({submit});
    try{expect((await s.client.callTool({name:'rbridge_submit',arguments:{...request,operation}})).structuredContent).toMatchObject({status:'CORE_RECEIPT'});expect(submit.mock.calls[0]![0]).toMatchObject({operationId:'health-test',operation,principalId:'operator-test',targetInstanceId:'target-test'});}finally{await s.close();}
  });
  it.each(['legacy','modern'] as const)('forwards cancellation to the core without another submission (%s)',async era=>{
    let entered!:()=>void,observed!:()=>void;const onEntered=new Promise<void>(ok=>entered=ok),onObserved=new Promise<void>(ok=>observed=ok);
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1,_context:unknown,signal:AbortSignal)=>{
      entered();await new Promise<void>(ok=>signal.addEventListener('abort',()=>{observed();ok();},{once:true}));
      return {status:'RECEIPT' as const,receipt:{...receipt(submission),outcome:'UNCERTAIN' as const,cancellation:{state:'UNKNOWN' as const},sideEffects:{state:'UNKNOWN' as const}}};
    });
    const s=await session({submit},era==='legacy'?'legacy':{pin:'2026-07-28'});const controller=new AbortController();
    try{const pending=s.client.callTool({name:'rbridge_submit',arguments:request},{signal:controller.signal}).catch(error=>error as unknown);await onEntered;controller.abort();await onObserved;expect(await pending).toBeInstanceOf(Error);expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0]![2].aborted).toBe(true);}finally{await s.close();}
  });
  it.each(['missing-outcome','non-monotonic','unsafe-policy','unproven-stop','failed-postcondition','unknown-postcondition','unauthorized-pass'] as const)('rejects an unusable returned receipt (%s)',async problem=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>{
      const row=receipt(submission);
      if(problem==='missing-outcome')delete row.outcome;
      if(problem==='non-monotonic')row.transitions=[{phase:'TERMINAL',at:'2026-10-04T00:00:00.000Z'},{phase:'RUNNING',at:'2026-10-04T00:00:00.001Z'}];
      if(problem==='unsafe-policy')row.policy.decision='BLOCK';
      if(problem==='unproven-stop')row.cancellation={state:'PROCESS_PROVEN_STOPPED'};
      if(problem==='failed-postcondition')row.postconditions=[{name:'required-proof',status:'FAIL'}];
      if(problem==='unknown-postcondition')row.postconditions=[{name:'required-proof',status:'UNKNOWN'}];
      if(problem==='unauthorized-pass')row.transitions=[row.transitions[0]!,row.transitions.at(-1)!];
      return {status:'RECEIPT' as const,receipt:row};
    });const s=await session({submit});
    try{expect((await s.client.callTool({name:'rbridge_submit',arguments:request})).structuredContent).toMatchObject({status:'UNCERTAIN'});expect(submit).toHaveBeenCalledTimes(1);}finally{await s.close();}
  });
  it.each(['principalId','targetInstanceId','intentSha256','operationId','schema'] as const)('rejects a returned receipt with mismatched %s',async key=>{
    const submit=vi.fn(async(submission:RBridgeOperationSubmissionV1)=>({status:'RECEIPT' as const,receipt:{...receipt(submission),[key]:'other'} as RBridgeExecutionReceiptV1}));const s=await session({submit});
    try{const result=await s.client.callTool({name:'rbridge_submit',arguments:request});expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({status:'UNCERTAIN'});expect(submit).toHaveBeenCalledTimes(1);}finally{await s.close();}
  });
});

describe('reachable MCP entrypoint',()=>{
  it('rejects a real/effective UID mismatch before attaching stdio',async()=>{
    const user=userInfo();vi.stubEnv('RBRIDGE_RUNTIME_USER',user.username);vi.stubEnv('RBRIDGE_MCP_PRINCIPAL_ID','cli-test');vi.stubEnv('RBRIDGE_INSTANCE_ID','cli-target');const spy=vi.spyOn(process,'getuid').mockReturnValue(user.uid+1);
    try{await expect(runRBridgeMcpMain()).rejects.toThrow('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');}finally{spy.mockRestore();vi.unstubAllEnvs();}
  });
  it.each(['legacy','modern'] as const)('enforces the OS boundary in the real process and keeps stdout for protocol only (%s)',async()=>{
    const user=userInfo();const config={RBRIDGE_RUNTIME_USER:user.username,RBRIDGE_MCP_PRINCIPAL_ID:'cli-test',RBRIDGE_INSTANCE_ID:'cli-target'};
    const args=['--import','tsx',resolve('src/server/rbridgeMcpMain.ts')];
    const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH??'',...config},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=String(b));child.stderr.on('data',b=>stderr+=String(b));child.stdin.end();
    const code=await new Promise<number|null>((ok,bad)=>{child.once('error',bad);child.once('exit',ok);});
    expect(code).toBe(1);expect(stdout).toBe('');expect(JSON.parse(stderr)).toMatchObject({status:'FAIL',reason:user.uid===0?'RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID':'RBRIDGE_MCP_STARTUP_FAILED'});
  },15000);
});
