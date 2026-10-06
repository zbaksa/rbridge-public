import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {acceptRBridgeInstallation,createSourceAcceptanceProfile,type InstallAcceptanceInput,type InstallAcceptanceCase} from '../../src/cli/rbridgeInstallationAccept.js';
import {core,request,fence,reseal,canonicalSha,sha} from '../fixtures/rbridge-reader-carriers.js';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {rbridgeOperationIntentDigest,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {remoteBridgeRequestV2Digest} from '../../src/domain/remoteBridgeStage2Protocol.js';
import {createFixtureSdkReadClient,type McpReadClient} from '../../src/installation/rbridge-installation-client.js';
import type {ReaderExpectation} from '../../src/installation/rbridge-installation-reader.js';
import {createRBridgeAcceptanceFixture} from '../fixtures/rbridge-acceptance-owner.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {CarrierCapture} from '../../src/installation/rbridge-installation-reader.js';
const canary=Buffer.from('installation canary fixture\n'),hash=(v:unknown)=>canonicalSha(v);
function fixture(){
  const profile=JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8'));
  profile.binding={...profile.binding,principal_id:'fixture-operator',target_instance_id:'fixture-host',repository:'fixture-owner/fixture',author:'fixture-owner',github_subject:'fixture-owner/fixture:fixture-owner'};profile.paths.canary_path='/mnt/data/canary.txt';profile.service.canary_sha256=sha(canary);
  const calls:string[]=[];
  const cases=(['HEALTH','FILE'] as const).map((kind,index)=>{
    const f=core(),id='install-'+kind.toLowerCase(),operation=kind==='HEALTH'?{kind:'HEALTH',action:'STATUS'} as const:{kind:'FILE',action:'READ',target:'/mnt/data/canary.txt',args:{}} as const;
    const req={...request,requestId:id,operation};const scope={...f.expected.scope!,operationId:id},submission={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...scope,operation} as RBridgeOperationSubmissionV1;
    const output=kind==='HEALTH'?f.output:{path:'/mnt/data/canary.txt',text:canary.toString()};
    const receipt={...f.receipt,...scope,intentSha256:rbridgeOperationIntentDigest(submission),resultSha256:hash(output)};const payload={schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt,output};
    f.capture.issue={...f.capture.issue,number:17+index,title:'[COCWIN BRIDGE REQUEST] '+id,body:JSON.stringify(req),url:'https://github.com/fixture-owner/fixture/issues/'+(17+index)};
    const envelope={...f.envelope,requestId:id,issueNumber:17+index,requestSha256:remoteBridgeRequestV2Digest(req),operationResult:payload,resultSha256:sha(JSON.stringify(payload))};
    f.capture.comments=[{...f.capture.comments[0]!,body:fence(envelope),url:f.capture.issue.url+'#issuecomment-1'}];reseal(f);
    const expected:ReaderExpectation={...f.expected,issue_number:17+index,request_id:id,request_title:f.capture.issue.title,request_body_sha256:sha(f.capture.issue.body),scope,intent_sha256:receipt.intentSha256};
    const bytes=Buffer.from(JSON.stringify(output,Object.keys(output).sort()));
    const client:McpReadClient={scope:'FIXTURE_AUTHORITY_ONLY',sdk_package_version:'2.3.0',protocol_era:'modern',negotiated_protocol_version:'2026-07-28',async callTool(input){calls.push(input.name+':'+id);let row:Record<string,unknown>;
      if(input.name==='rbridge_capabilities')row={schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:scope.principalId,targetInstanceId:scope.targetInstanceId,supportedKinds:['HEALTH','FILE','PROCESS','CHUNK'],enabledActions:['HEALTH/STATUS','FILE/READ'],executionAvailable:true,executionStatus:'CORE_CONNECTED',policySha256:receipt.policy.policySha256};
      else if(input.name==='rbridge_status')row={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:{status:'RECEIPT',receipt}};
      else{const cursor=input.arguments.cursor as number,max=input.arguments.maxBytes as number,part=bytes.subarray(cursor,cursor+max);row={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:{status:'RESULT',receipt,resultSha256:receipt.resultSha256,cursor,nextCursor:cursor+part.length,eof:cursor+part.length===bytes.length,dataBase64:part.toString('base64')}};}
      return {content:[{type:'text',text:JSON.stringify(row)}],structuredContent:row};}};
    return {kind,capture:f.capture,expected,client,receipt,output};
  });
  profile.binding.policy_sha256=cases[0]!.receipt.policy.policySha256;
  const input:InstallAcceptanceInput={profile:parseRBridgeInstallProfile(profile),stage:'ORIGINAL',captured_at:'2026-10-05T10:21:00.000Z',canary_base64:canary.toString('base64'),cases};return {input,calls,cases};
}
describe('installation acceptance through complete reference readers',()=>{
  it('compares both exact outputs and keeps source acceptance separate from installation',async()=>{const f=fixture(),r=await acceptRBridgeInstallation(f.input);expect(r.status,r.reason_codes.join(',')).toBe('PASS');expect(r.accepted).toBe(false);expect(r.scope).toBe('REFERENCE_ACCEPTANCE_ONLY');expect(r.operations).toHaveLength(2);expect(f.calls.every(c=>!c.includes('submit'))).toBe(true);});
  it('post-TTL closed replay retains original inner receipt/output and selected carrier',async()=>{const f=fixture(),original=await acceptRBridgeInstallation(f.input);expect(original.status).toBe('PASS');const r=await acceptRBridgeInstallation({...f.input,stage:'REPLAY',original});expect(r.status).toBe('PASS');expect(r.operations.map(r=>[r.receipt_sha256,r.output_sha256,r.comment_id])).toEqual(original.operations.map(r=>[r.receipt_sha256,r.output_sha256,r.comment_id]));});
  it('wrong author, scope, policy, canary or missing output cannot pass after rehashing',async()=>{
    for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.cases[0]!.capture.issue.author='attacker';},(f:ReturnType<typeof fixture>)=>{f.cases[0]!.expected.scope!.principalId='attacker';},(f:ReturnType<typeof fixture>)=>{f.cases[0]!.expected.policy_sha256='f'.repeat(64);},(f:ReturnType<typeof fixture>)=>{f.input.canary_base64=Buffer.from('changed').toString('base64');},(f:ReturnType<typeof fixture>)=>{f.cases[1]!.client.callTool=async()=>({});}]){const f=fixture();mutate(f);expect((await acceptRBridgeInstallation(f.input)).status).not.toBe('PASS');}
  });
  it('scope and client-version strings cannot qualify actual installed readers',async()=>{const f=fixture();f.cases[0]!.client.scope='QUALIFIED_INSTALLED_MCP_CLIENT';expect((await acceptRBridgeInstallation(f.input)).status).not.toBe('PASS');});
  it('replay before TTL, on an open carrier, or without pinned original truth is blocked',async()=>{for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.input.captured_at='2026-10-05T10:01:00.000Z';},(f:ReturnType<typeof fixture>)=>{f.cases[0]!.capture.issue.state='OPEN';}]){const f=fixture(),original=await acceptRBridgeInstallation(f.input);mutate(f);expect((await acceptRBridgeInstallation({...f.input,stage:'REPLAY',original})).status).not.toBe('PASS');}const f=fixture();expect((await acceptRBridgeInstallation({...f.input,stage:'REPLAY'})).status).not.toBe('PASS');});
  it('an arbitrary operation or reused canary identity is refused before querying',async()=>{const f=fixture();f.cases[1]!.expected.request_id=f.cases[0]!.expected.request_id;const r=await acceptRBridgeInstallation(f.input);expect(r.status).not.toBe('PASS');expect(f.calls).toEqual([]);});
  it.runIf((process.getuid?.()??0)>0)('genuine non-root source owner and both SDK eras preserve two reads across restart, lost close ACK and TTL',async()=>{
    const f=await createRBridgeAcceptanceFixture();
    try{
      const source='b5881fd8367b4249e82683f1f884f2392cb696d4',actor=await f.start({releaseSha:source}),legacy=await f.stdio('legacy'),modern=await f.stdio('modern');
      const bytes=Buffer.from('acceptance source\n'),template=JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8'));
      template.binding={...template.binding,principal_id:f.binding.principalId,target_instance_id:f.binding.targetInstanceId,repository:'example/control',author:'owner',github_subject:'example/control:owner'};template.paths.canary_path='/mnt/data/source.txt';template.service.canary_sha256=sha(bytes);
      const policy=createRBridgeExecutionPolicy(f.binding),healthOp={kind:'HEALTH',action:'STATUS'} as const,fileOp={kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}} as const;
      template.binding.policy_sha256=policy.evaluate(f.submission('accept-health',healthOp)).snapshot.policySha256;const profile=createSourceAcceptanceProfile(template);
      const issues=[f.issue('accept-health',healthOp,17,1500),f.issue('accept-file',fileOp,18,1500)];f.failCloseOnce();
      for(const issue of issues)expect(await actor.request('ADMIT',issue)).toBe('CORE');
      for(const issue of issues){const deadline=Date.now()+10000;for(;;){const row=(await modern.callTool({name:'rbridge_status',arguments:{operationId:JSON.parse(issue.body).requestId}})).structuredContent as {result?:{receipt?:{phase:string}}};if(row.result?.receipt?.phase==='TERMINAL')break;if(Date.now()>=deadline)throw new Error('SOURCE_ACCEPTANCE_TERMINAL_DEADLINE');await new Promise<void>(done=>setTimeout(done,5));}}
      await actor.request('DRAIN');expect(await actor.request('COUNTS')).toEqual({health:1,reads:1});
      const build=async(replay=false):Promise<InstallAcceptanceInput>=>{
        const clients=await Promise.all([createFixtureSdkReadClient(replay?modern:legacy),createFixtureSdkReadClient(replay?legacy:modern)]),cases:InstallAcceptanceCase[]=issues.map((issue,index)=>{
          const row=f.issues.get(issue.number)!,req=JSON.parse(row.body),scope={operationId:req.requestId,principalId:f.binding.principalId,targetInstanceId:f.binding.targetInstanceId},submission=f.submission(req.requestId,index===0?healthOp:fileOp);
          const base={schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1' as const,scope:'FIXTURE_AUTHORITY_ONLY' as const,context_sha256:'c'.repeat(64),repository:'example/control',viewer:'owner',issue:{number:row.number,title:row.title,body:row.body,author:row.authorLogin,url:row.url!,state:row.state==='closed'?'CLOSED' as const:'OPEN' as const,isPullRequest:false as const},comments:(f.comments.get(row.number)??[]).map(c=>({id:c.id,author:c.authorLogin,body:c.body,url:c.url})),complete:true as const};const capture:CarrierCapture={...base,capture_sha256:installHash(base)};
          const expected:ReaderExpectation={producer_source_sha:source,mode:'CORE',repository:'example/control',author:'owner',issue_number:row.number,request_id:req.requestId,request_title:row.title,request_body_sha256:sha(row.body),capture_context_sha256:base.context_sha256,capture_sha256:capture.capture_sha256,digest_branch:'ADMITTED_CANONICAL_REQUEST',expected_source_sha:source,scope,runtime_uid:f.binding.runtimeUid,intent_sha256:rbridgeOperationIntentDigest(submission),policy_sha256:template.binding.policy_sha256};
          return {kind:index===0?'HEALTH':'FILE',capture,expected,client:clients[index]!};
        });return {profile,stage:replay?'REPLAY':'ORIGINAL',captured_at:new Date().toISOString(),canary_base64:bytes.toString('base64'),cases};
      };
      const original=await acceptRBridgeInstallation(await build());expect(original.status,original.reason_codes.join(',')).toBe('PASS');expect(original.accepted).toBe(false);
      await actor.close();const replacement=await f.start({releaseSha:source});await replacement.request('DRAIN');
      const delay=Math.max(...issues.map(i=>Date.parse(JSON.parse(i.body).expiresAt)))-Date.now()+1;if(delay>0)await new Promise<void>(done=>setTimeout(done,delay));
      const replay=await acceptRBridgeInstallation({...await build(true),original});expect(replay.status,replay.reason_codes.join(',')).toBe('PASS');expect(replay.operations.map(o=>[o.receipt_sha256,o.output_sha256])).toEqual(original.operations.map(o=>[o.receipt_sha256,o.output_sha256]));expect(await replacement.request('COUNTS')).toEqual({health:0,reads:0});
    }finally{await f.close();}
  },30000);
});
