import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeCoreBinding,type RBridgeCorePort} from '../../src/domain/rbridgeCoreProtocol.js';
import {rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {connectRBridgeCoreIpcClient} from '../../src/server/rbridgeCoreIpc.js';
import {cleanupRBridgeIpcFixtures,createRBridgeIpcFixture} from '../fixtures/rbridge-ipc-owner.js';
import {createRBridgeStdioOwnerFixture,mcpTestPort} from '../fixtures/rbridge-stdio-owner.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();await cleanupRBridgeIpcFixtures();});
const request={operationId:'health-test',operation:{kind:'HEALTH',action:'STATUS'}};
const binding={authenticatedSubject:'uid:1027',principalId:'operator-test',targetInstanceId:'target-test'};
const ownerBinding:RBridgeCoreBinding={schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',runtimeUid:1027,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,policySha256:'a'.repeat(64),enabledActions:RBRIDGE_ENABLED_ACTIONS};
async function memory(core:RBridgeCorePort,provider:()=>Promise<RBridgeCoreBinding>=async()=>ownerBinding){
  const [transport,wire]=InMemoryTransport.createLinkedPair(),handle=serveStdio(()=>createRBridgeMcpSafeServer({binding,core,bindingProvider:provider}),{transport:wire}),client=new Client({name:'untrusted',version:'test'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(transport);cleanup.push(async()=>{await client.close();await handle.close();});return client;
}
async function owner(options?:Parameters<typeof createRBridgeStdioOwnerFixture>[0]){const f=await createRBridgeStdioOwnerFixture(options);cleanup.push(()=>f.close());return f;}
async function stdio(f:Awaited<ReturnType<typeof owner>>,era:'legacy'|'modern',production=false){
  const args=['--import','tsx',resolve(production?'src/server/rbridgeMcpMain.ts':'tests/fixtures/rbridge-stdio-owner.ts'),...(production?[]:['--client',f.root])],transport=new StdioClientTransport({command:process.execPath,args,env:{PATH:process.env.PATH??'',RBRIDGE_RUNTIME_USER:f.user.username,RBRIDGE_MCP_PRINCIPAL_ID:f.deployment.principalId,RBRIDGE_INSTANCE_ID:f.deployment.targetInstanceId},stderr:'pipe'}),client=new Client({name:'attacker-display-name',version:'test'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});let stderr='';transport.stderr?.on('data',b=>stderr+=String(b));await client.connect(transport);cleanup.push(()=>client.close());return {client,get stderr(){return stderr;}};
}
const object=(result:{structuredContent?:unknown})=>result.structuredContent as Record<string,unknown>;
describe('checked MCP shared-core mapping',()=>{
  it('known rejection is blocked without a fake receipt',async()=>{
    const submit=vi.fn(async(s:Parameters<RBridgeCorePort['submit']>[0])=>({status:'REJECTED' as const,reason:'RBRIDGE_CORE_INTENT_COLLISION' as const,operationId:s.operationId,principalId:s.principalId,targetInstanceId:s.targetInstanceId})),client=await memory(mcpTestPort(submit));
    const result=object(await client.callTool({name:'rbridge_submit',arguments:request}));expect(result).toMatchObject({status:'BLOCKED',reason:'RBRIDGE_CORE_INTENT_COLLISION',operationId:'health-test',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId});expect(Object.hasOwn(result,'receipt')).toBe(false);expect(submit).toHaveBeenCalledTimes(1);
  });
  it('owner loss clears connected capabilities and blocks before delegation',async()=>{
    let connected=true;const submit=vi.fn(async()=>{throw new Error('SHOULD_NOT_DELEGATE');}),provider=async()=>{if(!connected)throw new Error('PRIVATE_OWNER_TEXT');return ownerBinding;},client=await memory(mcpTestPort(submit),provider);
    expect(object(await client.callTool({name:'rbridge_capabilities',arguments:{}}))).toMatchObject({executionAvailable:true,enabledActions:[...RBRIDGE_ENABLED_ACTIONS],policySha256:ownerBinding.policySha256});connected=false;
    const capabilities=object(await client.callTool({name:'rbridge_capabilities',arguments:{}}));expect(capabilities).toMatchObject({executionAvailable:false,executionStatus:'BLOCKED',enabledActions:[]});expect(capabilities.policySha256).toBeUndefined();expect(object(await client.callTool({name:'rbridge_submit',arguments:request}))).toMatchObject({status:'BLOCKED',reason:'RBRIDGE_MCP_CORE_UNAVAILABLE'});expect(submit).not.toHaveBeenCalled();expect(JSON.stringify(capabilities)).not.toContain('PRIVATE_OWNER_TEXT');
  });
  it.each([{runtimeUid:1},{principalId:'attacker'},{targetInstanceId:'other'},{journalSchema:'FOREIGN'},{policySha256:'invalid'},{enabledActions:['PROCESS/START']}])('refuses an invalid or foreign binding before delegation (%#)',async patch=>{
    const submit=vi.fn(async()=>{throw new Error('SHOULD_NOT_DELEGATE');}),client=await memory(mcpTestPort(submit),async()=>({...ownerBinding,...patch} as RBridgeCoreBinding));expect(object(await client.callTool({name:'rbridge_submit',arguments:request}))).toMatchObject({status:'BLOCKED'});expect(submit).not.toHaveBeenCalled();
  });
  it('fresh capabilities use the current authenticated policy and enabled subset',async()=>{
    const client=await memory(mcpTestPort(async()=>{throw new Error();}),async()=>({...ownerBinding,policySha256:'b'.repeat(64),enabledActions:['HEALTH/STATUS']}));expect(object(await client.callTool({name:'rbridge_capabilities',arguments:{}}))).toMatchObject({policySha256:'b'.repeat(64),enabledActions:['HEALTH/STATUS']});
  });
  it('status result and cancel derive scope locally and return checked query envelopes',async()=>{
    const core=mcpTestPort(async()=>{throw new Error();}),status=vi.spyOn(core,'status'),result=vi.spyOn(core,'result'),cancel=vi.spyOn(core,'requestCancel'),client=await memory(core);
    for(const [tool,args] of [['rbridge_status',{operationId:'query-test'}],['rbridge_result',{operationId:'query-test',cursor:0,maxBytes:32768}],['rbridge_cancel',{operationId:'query-test',intentSha256:'a'.repeat(64)}]] as const){const response=object(await client.callTool({name:tool,arguments:args,_meta:{principalId:'attacker',transport:'GITHUB'}}));expect(response).toMatchObject({schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool,result:{status:'NOT_FOUND',operationId:'query-test',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId}});}
    const ctx={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:binding.authenticatedSubject,principalId:binding.principalId};expect(status).toHaveBeenCalledWith('query-test',ctx);expect(result).toHaveBeenCalledWith('query-test',0,32768,ctx);expect(cancel).toHaveBeenCalledWith('query-test','a'.repeat(64),ctx);
  });
  it.each([
    ['rbridge_status',{operationId:'../bad'}],['rbridge_status',{operationId:'q',principalId:'attacker'}],['rbridge_result',{operationId:'q',cursor:-1,maxBytes:1}],['rbridge_result',{operationId:'q',cursor:8388609,maxBytes:1}],['rbridge_result',{operationId:'q',cursor:0,maxBytes:32769}],['rbridge_result',{operationId:'q',cursor:0.5,maxBytes:1}],['rbridge_result',{operationId:'q',cursor:0,maxBytes:0}],['rbridge_cancel',{operationId:'q',intentSha256:'not-a-digest'}],['rbridge_cancel',{operationId:'q',intentSha256:'a'.repeat(64),targetInstanceId:'other'}],
  ])('rejects invalid query arguments before touching ports (%#)',async(tool,args)=>{
    const core=mcpTestPort(async()=>{throw new Error();}),status=vi.spyOn(core,'status'),result=vi.spyOn(core,'result'),cancel=vi.spyOn(core,'requestCancel'),client=await memory(core);expect((await client.callTool({name:String(tool),arguments:args as Record<string,unknown>})).isError).toBe(true);expect(status).not.toHaveBeenCalled();expect(result).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();
  });
  it.each(['rbridge_status','rbridge_result','rbridge_cancel'])('an invalid delegated %s response is uncertain and cannot leak text',async tool=>{
    const core=mcpTestPort(async()=>{throw new Error();});core.status=async()=>({status:'NOT_FOUND',operationId:'q',principalId:'attacker',targetInstanceId:binding.targetInstanceId});core.result=async()=>{throw new Error('PRIVATE_QUERY_TEXT');};core.requestCancel=async()=>({status:'NOT_FOUND',operationId:'different',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId});const client=await memory(core),args=tool==='rbridge_status'?{operationId:'q'}:tool==='rbridge_result'?{operationId:'q',cursor:0,maxBytes:1}:{operationId:'q',intentSha256:'a'.repeat(64)};
    const result=await client.callTool({name:tool,arguments:args});expect(object(result)).toMatchObject({status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'});expect(JSON.stringify(result)).not.toContain('PRIVATE_QUERY_TEXT');
  });
  it.each(['hash','range','base64','scope','extra','bytes'] as const)('rejects an unverified result-page response (%s)',async problem=>{
    const bytes=Buffer.from('{"ok":true}'),hash=createHash('sha256').update(bytes).digest('hex');
    const receipt:RBridgeExecutionReceiptV1={schema:'RBRIDGE_EXECUTION_RECEIPT_V1',operationId:'q',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,intentSha256:'a'.repeat(64),policy:{schema:'RBRIDGE_POLICY_SNAPSHOT_V1',mode:'SAFE',policyVersion:'test',policySha256:'b'.repeat(64),decision:'ALLOW'},phase:'TERMINAL',outcome:'PASS',resultSha256:hash,cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL'] as const).map((phase,index)=>({phase,at:`2026-10-05T00:00:00.00${index}Z`})),postconditions:[]};
    const page={status:'RESULT' as const,receipt,resultSha256:hash,cursor:0,nextCursor:bytes.length,eof:true,dataBase64:bytes.toString('base64')};
    if(problem==='hash')page.resultSha256='c'.repeat(64);if(problem==='range')page.nextCursor++;if(problem==='base64')page.dataBase64='not-base64';if(problem==='scope')page.receipt={...receipt,principalId:'attacker'};if(problem==='extra')Object.assign(page,{untrusted:true});if(problem==='bytes'){page.dataBase64=Buffer.alloc(32769).toString('base64');page.nextCursor=32769;}
    const core=mcpTestPort(async()=>{throw new Error();}),result=vi.fn(async()=>page);core.result=result;const client=await memory(core);expect(object(await client.callTool({name:'rbridge_result',arguments:{operationId:'q',cursor:0,maxBytes:32768}}))).toMatchObject({status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'});expect(result).toHaveBeenCalledTimes(1);
  });
});
describe('real SDK stdio with an actual journal and Linux owner',()=>{
  it.each(['legacy','modern'] as const)('modern and legacy stdio clients share checked core results (%s)',async era=>{
    const f=await owner(),a=await stdio(f,era),b=await stdio(f,era),args={operationId:'shared-stdio',operation:{kind:'FILE',action:'READ',target:'/mnt/data/read.txt',args:{}}};
    expect((await a.client.listTools()).tools.map(t=>t.name).sort()).toEqual(['rbridge_cancel','rbridge_capabilities','rbridge_result','rbridge_status','rbridge_submit']);expect(object(await a.client.callTool({name:'rbridge_capabilities',arguments:{}}))).toMatchObject({executionAvailable:true,policySha256:f.binding.policySha256,enabledActions:[...RBRIDGE_ENABLED_ACTIONS]});
    for(const client of [a.client,b.client])expect(object(await client.callTool({name:'rbridge_submit',arguments:args}))).toMatchObject({status:'CORE_RECEIPT'});
    const receipt=await f.terminal();expect(f.calls).toBe(1);const before=await readFile(join(f.root,'operations/shared-stdio.json'));
    expect(object(await b.client.callTool({name:'rbridge_status',arguments:{operationId:'shared-stdio'}}))).toMatchObject({result:{status:'RECEIPT',receipt}});
    const page=object(await a.client.callTool({name:'rbridge_result',arguments:{operationId:'shared-stdio',cursor:0,maxBytes:32768}})).result as {status:string;dataBase64:string;resultSha256:string;eof:boolean;receipt:unknown};const bytes=Buffer.from(page.dataBase64,'base64');expect(page).toMatchObject({status:'RESULT',resultSha256:receipt.resultSha256,eof:true,receipt});expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.resultSha256);expect(JSON.parse(bytes.toString())).toMatchObject({text:'é durable read\n'});
    await a.client.close();const reconnected=await stdio(f,era);expect(object(await reconnected.client.callTool({name:'rbridge_submit',arguments:args}))).toMatchObject({receipt});expect(f.calls).toBe(1);expect(await readFile(join(f.root,'operations/shared-stdio.json'))).toEqual(before);expect(a.stderr+b.stderr+reconnected.stderr).toBe('');
  },30000);
  it('disabled SAFE uses a durable BLOCK receipt and no read handler',async()=>{
    const f=await owner(),s=await stdio(f,'modern');const response=object(await s.client.callTool({name:'rbridge_submit',arguments:{operationId:'disabled-stdio',operation:{kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/new',args:{text:'never-write'}}}}));expect(response).toMatchObject({status:'CORE_RECEIPT',receipt:{outcome:'BLOCKED',phase:'TERMINAL'}});expect(f.calls).toBe(0);expect((await f.journal.get('disabled-stdio'))!.receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','TERMINAL']);
  });
  it('explicit cancellation records intent and waits for real read settlement',async()=>{
    const f=await owner({holdHealth:true}),s=await stdio(f,'modern');await s.client.callTool({name:'rbridge_submit',arguments:{operationId:'shared-stdio',operation:{kind:'HEALTH',action:'STATUS'}}});await f.healthEntered;
    const result=object(await s.client.callTool({name:'rbridge_cancel',arguments:{operationId:'shared-stdio',intentSha256:rbridgeOperationIntentDigest(f.submission())}}));expect(result).toMatchObject({result:{status:'REQUESTED',receipt:{cancellation:{state:'REQUESTED'}}}});expect((await f.core.status('shared-stdio',f.context))).toMatchObject({receipt:{phase:'RUNNING'}});f.releaseHealth();expect(await f.terminal()).toMatchObject({outcome:'TERMINATED',sideEffects:{state:'NONE_PROVEN'}});expect(f.calls).toBe(1);
  });
  it('a real owner disconnect clears capabilities and reconnect status preserves the original ID',async()=>{
    const f=await owner(),s=await stdio(f,'modern');await s.client.callTool({name:'rbridge_submit',arguments:{operationId:'shared-stdio',operation:{kind:'HEALTH',action:'STATUS'}}});const receipt=await f.terminal();await f.stopIPC();expect(object(await s.client.callTool({name:'rbridge_capabilities',arguments:{}}))).toMatchObject({executionAvailable:false,enabledActions:[]});expect(object(await s.client.callTool({name:'rbridge_submit',arguments:{operationId:'lost-owner',operation:{kind:'HEALTH',action:'STATUS'}}}))).toMatchObject({status:'BLOCKED'});await f.restartIPC();expect(object(await s.client.callTool({name:'rbridge_status',arguments:{operationId:'shared-stdio'}}))).toMatchObject({result:{receipt}});expect(f.calls).toBe(1);expect(await f.journal.get('lost-owner')).toBeUndefined();
  });
  it('lost submit and cancel acknowledgements are uncertain with one submission and no retry',async()=>{
    const f=await createRBridgeIpcFixture(),requests:string[]=[];await f.rogue((request,socket)=>{requests.push(request.action);if(request.action==='BINDING')socket.end(JSON.stringify({schema:'RBRIDGE_CORE_RPC_RESULT_V1',action:'BINDING',value:f.binding})+'\n');else socket.destroy();});const core=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});cleanup.push(()=>core.close());const [transport,wire]=InMemoryTransport.createLinkedPair(),handle=serveStdio(()=>createRBridgeMcpSafeServer({binding:{authenticatedSubject:`uid:${f.uid}`,principalId:f.deployment.principalId,targetInstanceId:f.deployment.targetInstanceId},core,bindingProvider:()=>core.binding()}),{transport:wire}),client=new Client({name:'lost-ack',version:'test'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(transport);cleanup.push(async()=>{await client.close();await handle.close();});expect(object(await client.callTool({name:'rbridge_submit',arguments:{operationId:'health-1',operation:{kind:'HEALTH',action:'STATUS'}}}))).toMatchObject({status:'UNCERTAIN',reason:'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'});expect(requests.filter(a=>a==='SUBMIT')).toHaveLength(1);expect(requests.filter(a=>a==='CANCEL_INTENT')).toHaveLength(1);
  });
  it.each(['legacy','modern'] as const)('the production entrypoint uses verified OS homedir and the real owner (%s)',async era=>{
    const f=await owner({fixedHome:true}),s=await stdio(f,era,true);expect((await s.client.listTools()).tools).toHaveLength(5);expect(object(await s.client.callTool({name:'rbridge_submit',arguments:{operationId:'shared-stdio',operation:{kind:'HEALTH',action:'STATUS'}}}))).toMatchObject({status:'CORE_RECEIPT'});expect(await f.terminal()).toMatchObject({outcome:'PASS'});expect(f.calls).toBe(1);expect(s.stderr).toBe('');
  },30000);
});
