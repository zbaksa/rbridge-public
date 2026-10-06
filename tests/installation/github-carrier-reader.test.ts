import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {readRBridgeGitHubCarrier} from '../../src/installation/githubCarrierReader.js';
import {parseRBridgeCarrierJson} from '../../src/installation/carrierJson.js';
import {installHash} from '../../src/installation/gateContext.js';
import {remoteBridgeRequestV2Digest,type RemoteBridgeRequestV2} from '../../src/domain/remoteBridgeStage2Protocol.js';
import type {CarrierCapture,ReaderExpectation} from '../../src/installation/rbridge-installation-reader.js';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import {rbridgeOperationIntentDigest,type RBridgeJsonValue,type RBridgeExecutionReceiptV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {createGitHubIssueRemoteBridge} from '../../src/adapters/githubIssueRemoteBridge.js';
import {createRBridgeGitHubFixture,githubRepository,githubAuthor} from '../fixtures/rbridge-github.js';
import {cleanupRBridgeTestStates} from '../fixtures/rbridge-core-state.js';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const source='b5881fd8367b4249e82683f1f884f2392cb696d4',old='008885e07394f20746f034cbd7fe52c6b520533d';
const fence=(v:unknown)=>'```json\n'+JSON.stringify(v,null,2)+'\n```\n';
const request:RemoteBridgeRequestV2={schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:'fixture-read',createdAt:'2026-10-05T10:00:00.000Z',expiresAt:'2026-10-05T10:20:00.000Z',operation:{kind:'HEALTH',action:'STATUS'}};
const health={schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:old,uptimeMs:1,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};
// Synthetic source-format fixtures; actual producer/archive/adoption proof is separate.
function fixture(value:Record<string,unknown>={operationResult:health,resultSha256:sha(JSON.stringify(health)),status:'PASS'},body=JSON.stringify(request)){
  const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:request.requestId,issueNumber:17,requestSha256:remoteBridgeRequestV2Digest(request),completedAt:'2026-10-05T10:01:00.000Z',...value};
  const base={schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1' as const,scope:'FIXTURE_AUTHORITY_ONLY' as const,context_sha256:'c'.repeat(64),repository:'fixture-owner/fixture',viewer:'fixture-owner',issue:{number:17,title:'[COCWIN BRIDGE REQUEST] fixture-read',body,author:'fixture-owner',url:'https://github.com/fixture-owner/fixture/issues/17',state:'CLOSED' as const,isPullRequest:false as const},comments:[{id:1,author:'fixture-owner',body:fence(envelope),url:'https://github.com/fixture-owner/fixture/issues/17#issuecomment-1'}],complete:true as const};
  const capture:CarrierCapture={...base,capture_sha256:installHash(base)};
  const expected:ReaderExpectation={producer_source_sha:source,mode:'LEGACY',repository:base.repository,author:base.viewer,issue_number:17,request_id:request.requestId,request_title:base.issue.title,request_body_sha256:sha(body),capture_context_sha256:base.context_sha256,capture_sha256:capture.capture_sha256,digest_branch:'ADMITTED_CANONICAL_REQUEST',expected_source_sha:old};
  return {capture,expected,envelope};
}
function reseal(f:ReturnType<typeof fixture>){const {capture_sha256:_,...base}=f.capture;void _;f.capture.capture_sha256=installHash(base);f.expected.capture_sha256=f.capture.capture_sha256;}
const canonicalSha=(v:unknown)=>sha(canonicalRBridgeJson(v as RBridgeJsonValue));
function core(outcome:RBridgeExecutionReceiptV1['outcome']='PASS'){
  const scope={operationId:request.requestId,principalId:'fixture-operator',targetInstanceId:'fixture-host'},submission={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',...scope,operation:request.operation},policy=createRBridgeExecutionPolicy({runtimeUid:1027,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId}).evaluate(submission as Parameters<ReturnType<typeof createRBridgeExecutionPolicy>['evaluate']>[0]).snapshot;
  const output={...health,releaseSha:source};
  const receipt:RBridgeExecutionReceiptV1={schema:'RBRIDGE_EXECUTION_RECEIPT_V1',...scope,intentSha256:rbridgeOperationIntentDigest(submission),policy:structuredClone(policy),phase:'TERMINAL',outcome:outcome!,cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL'] as const).map(phase=>({phase,at:'2026-10-05T10:01:00.000Z'})),postconditions:[],...(outcome==='PASS'?{resultSha256:canonicalSha(output)}:{}),...(outcome==='TERMINATED'?{reason:'CONTROLLED_STOP'}:{})};
  const payload={schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt,...(outcome==='PASS'?{output}:{})},f=fixture({status:outcome==='TERMINATED'?'BLOCKED':outcome,operationResult:payload,resultSha256:sha(JSON.stringify(payload)),...(outcome==='TERMINATED'?{reason:'RBRIDGE_CORE_TERMINATED'}:{})});
  f.expected={...f.expected,mode:'CORE',expected_source_sha:source,runtime_uid:1027,scope,intent_sha256:receipt.intentSha256,policy_sha256:policy.policySha256};
  return {...f,receipt,payload,output};
}
function rewrite(f:ReturnType<typeof fixture>){f.capture.comments[0]!.body=fence(f.envelope);reseal(f);}
function chunks(f:ReturnType<typeof fixture>){
  const bytes=Buffer.from(JSON.stringify(f.envelope)),objectSha256=sha(bytes),transferId='result-'+objectSha256,count=Math.ceil(bytes.length/40000);let id=0;
  const comment=(body:string)=>({id:++id,author:'fixture-owner',body,url:'https://github.com/fixture-owner/fixture/issues/17#issuecomment-'+id});
  f.capture.comments=Array.from({length:count},(_,index)=>{const part=bytes.subarray(index*40000,(index+1)*40000);return comment(fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:part.toString('base64'),chunkSha256:sha(part),objectSha256}));});
  f.capture.comments.push(comment(fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:bytes.length,objectSha256})));reseal(f);
}
describe('strict authenticated GitHub carrier reference reader',()=>{
  it('C01 reads the six flat FILE formats and retains opaque APP nanosecond numbers using producer digests',()=>{
    const path='/mnt/data/fixture',data=Buffer.from('fixture');
    for(const [action,args,output] of [
      ['READ',{}, {path,text:'fixture'}],['STAT',{}, {path,type:'file',size:7,mtimeMs:1760000000000}],
      ['READ_BINARY',{}, {path,dataBase64:data.toString('base64'),bytes:data.length,sha256:sha(data)}],
      ['LIST',{}, {path,entries:[{name:'child',type:'file'}]}],['READ_MANY',{paths:['child']}, {files:[{path:path+'/child',text:'fixture'}]}],
      ['SEARCH',{query:'fixture'}, {matches:[{path:path+'/child'}],truncated:false}],
    ] as const){
      const req={...request,operation:{kind:'FILE' as const,action,target:path,args}},f=fixture({status:'PASS',operationResult:output,resultSha256:sha(JSON.stringify(output)),requestSha256:remoteBridgeRequestV2Digest(req)},JSON.stringify(req));
      expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('LEGACY_RESULT');
      (f.envelope as Record<string,unknown>).operationResult={...output,path:'/mnt/data/foreign'};(f.envelope as Record<string,unknown>).resultSha256=sha(JSON.stringify((f.envelope as Record<string,unknown>).operationResult));rewrite(f);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');
    }
    const req:RemoteBridgeRequestV2={...request,operation:{kind:'APP_RUN',appId:'fixture',jobId:'fixture-job',payload:{tool:'probe',cwd:'/mnt/data',args:[],timeout_ms:1000,max_bytes:4096}}};
    const value={schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'fixture',job:'fixture-job',state:'SUCCEEDED',returncode:0,stdout:'retained',stderr:'',timed_out:false,truncated:false,stat:{mtimeNs:1760000000000000000}},f=fixture({status:'PASS',operationResult:value,resultSha256:sha(JSON.stringify(value)),requestSha256:remoteBridgeRequestV2Digest(req)},JSON.stringify(req));
    const result=readRBridgeGitHubCarrier(f.capture,f.expected);expect(result.kind).toBe('LEGACY_RESULT');if(result.kind==='LEGACY_RESULT')expect(result.output).toEqual(value);expect(f.capture.comments[0]!.body).toContain('1760000000000000000');
  });
  it('strict capture completeness, comment identity integers, duplicate IDs and selected receipt survive no substitution',()=>{
    for(const change of [(f:ReturnType<typeof fixture>)=>{(f.capture as unknown as Record<string,unknown>).complete=false;},(f:ReturnType<typeof fixture>)=>{f.capture.comments[0]!.id=9007199254740992;},(f:ReturnType<typeof fixture>)=>{f.capture.comments.push({...f.capture.comments[0]!});},(f:ReturnType<typeof fixture>)=>{f.expected.selected_comment_id=999;}]){const f=fixture();change(f);try{reseal(f);}catch{/* Canonical evidence also refuses unsafe identity numbers. */}expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');}
    const f=fixture();f.capture.comments.push({...f.capture.comments[0]!,id:2,url:f.capture.issue.url+'#issuecomment-2'});reseal(f);f.expected.selected_comment_id=2;const r=readRBridgeGitHubCarrier(f.capture,f.expected);expect(r.kind).toBe('LEGACY_RESULT');if(r.kind==='LEGACY_RESULT')expect(r.evidence.selected_comment_id).toBe(2);
  });
  it('reads exact chunks emitted by the pinned source publisher, with a fixture transport',async()=>{
    const value={path:'/mnt/data/fixture',text:'x'.repeat(100000)},req={...request,operation:{kind:'FILE' as const,action:'READ' as const,target:'/mnt/data/fixture',args:{}}},f=fixture({status:'PASS',operationResult:value,resultSha256:sha(JSON.stringify(value)),requestSha256:remoteBridgeRequestV2Digest(req)},JSON.stringify(req));f.capture.comments=[];
    const publisher=createGitHubIssueRemoteBridge({repository:f.expected.repository,authorLogin:f.expected.author,runner:async input=>{if(input.args[0]==='issue'&&input.args[1]==='view')return {exitCode:0,stdout:'{"comments":[]}',stderr:''};if(input.args[0]==='issue'&&input.args[1]==='comment'){const id=f.capture.comments.length+1;f.capture.comments.push({id,body:input.stdin!,author:f.expected.author,url:f.capture.issue.url+'#issuecomment-'+id});}else expect(input.args[1]).toBe('close');return {exitCode:0,stdout:'',stderr:''};}});
    await publisher.publishResult(17,f.envelope);reseal(f);expect(f.capture.comments.length).toBe(4);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('LEGACY_RESULT');
  });
  it.skipIf((process.getuid?.()??0)===0)('reads genuine source Core/journal/publisher receipt under the qualified non-root CI runner',async()=>{
    const producer=await createRBridgeGitHubFixture({...health,releaseSha:source});
    try{
      const issue=producer.issue();await producer.adapter.admit(issue);const receipt=await producer.terminal();await producer.adapter.reconcileDeliveries(20);
      const base={schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1' as const,scope:'FIXTURE_AUTHORITY_ONLY' as const,context_sha256:'c'.repeat(64),repository:githubRepository,viewer:githubAuthor,issue:{number:17,title:issue.title,body:issue.body,author:issue.authorLogin,url:issue.url,state:'CLOSED' as const,isPullRequest:false as const},comments:producer.comments.get(17)!.map(c=>({id:c.id,author:c.authorLogin,body:c.body,url:c.url})),complete:true as const};
      const capture={...base,capture_sha256:installHash(base)},expected:ReaderExpectation={producer_source_sha:source,mode:'CORE',repository:githubRepository,author:githubAuthor,issue_number:17,request_id:'shared-read',request_title:issue.title,request_body_sha256:sha(issue.body),capture_context_sha256:base.context_sha256,capture_sha256:capture.capture_sha256,digest_branch:'ADMITTED_CANONICAL_REQUEST',expected_source_sha:source,runtime_uid:producer.uid,scope:{operationId:receipt.operationId,principalId:receipt.principalId,targetInstanceId:receipt.targetInstanceId},intent_sha256:receipt.intentSha256,policy_sha256:receipt.policy.policySha256};
      const result=readRBridgeGitHubCarrier(capture,expected);expect(result.kind).toBe('CORE_RESULT');if(result.kind==='CORE_RESULT')expect(result.receipt).toEqual(receipt);expect(producer.calls).toBe(1);
    }finally{await producer.close();await cleanupRBridgeTestStates();}
  });
  it('C02/C03 validates Core receipt and independent output; TERM maps to outer BLOCKED without output',()=>{
    for(const outcome of ['PASS','FAIL','BLOCKED','UNCERTAIN','TERMINATED'] as const){const f=core(outcome),r=readRBridgeGitHubCarrier(f.capture,f.expected);expect(r.kind).toBe('CORE_RESULT');expect(r.status).toBe(outcome==='TERMINATED'?'BLOCKED':outcome);if(r.kind==='CORE_RESULT')expect(r.receipt).toEqual(f.receipt);if(outcome!=='PASS')expect(r).not.toHaveProperty('output');}
  });
  it('C05/C06 a rehashed wrong scope, policy, output, terminal mapping or outer digest never passes',()=>{
    for(const change of [(f:ReturnType<typeof core>)=>{f.receipt.principalId='attacker';},(f:ReturnType<typeof core>)=>{f.receipt.policy.policySha256='f'.repeat(64);},(f:ReturnType<typeof core>)=>{f.receipt.policy.decision='BLOCK';},(f:ReturnType<typeof core>)=>{f.receipt.intentSha256='f'.repeat(64);},(f:ReturnType<typeof core>)=>{f.output.queueCount=1;},(f:ReturnType<typeof core>)=>{delete f.receipt.resultSha256;delete (f.payload as Record<string,unknown>).output;}]){const f=core();change(f);(f.envelope as Record<string,unknown>).resultSha256=sha(JSON.stringify(f.payload));rewrite(f);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');}
    const substituted=core();(substituted.envelope as Record<string,unknown>).resultSha256=substituted.receipt.resultSha256;rewrite(substituted);expect(readRBridgeGitHubCarrier(substituted.capture,substituted.expected).kind).toBe('INVALID');
    const term=core('TERMINATED');(term.envelope as Record<string,unknown>).status='PASS';rewrite(term);expect(readRBridgeGitHubCarrier(term.capture,term.expected).kind).toBe('INVALID');
  });
  it('C07 expired closed replay on a new issue preserves original receipt/output independently of carrier identity',()=>{
    const f=core(),before=JSON.stringify(f.receipt);f.expected.receipt_sha256=canonicalSha(f.receipt);f.expected.output_sha256=f.receipt.resultSha256!;
    f.capture.issue.number=18;f.capture.issue.url='https://github.com/fixture-owner/fixture/issues/18';f.expected.issue_number=18;(f.envelope as Record<string,unknown>).issueNumber=18;f.capture.comments[0]!.url=f.capture.issue.url+'#issuecomment-1';rewrite(f);
    expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('CORE_RESULT');expect(JSON.stringify(f.receipt)).toBe(before);
    f.expected.receipt_sha256='f'.repeat(64);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');
  });
  it('C08 absent collision carrier remains unavailable and cannot synthesize a receipt',()=>{const f=core();f.capture.comments=[];reseal(f);const r=readRBridgeGitHubCarrier(f.capture,f.expected);expect(r.kind).toBe('UNAVAILABLE');expect(r.status).toBe('UNKNOWN');expect(r).not.toHaveProperty('receipt');});
  it('C01/C05 reads flat HEALTH and retains original capture, without a receipt',()=>{const f=fixture(),before=JSON.stringify(f.capture),r=readRBridgeGitHubCarrier(f.capture,f.expected);expect(r.kind).toBe('LEGACY_RESULT');expect(r.status).toBe('PASS');expect(r).not.toHaveProperty('receipt');expect(JSON.stringify(f.capture)).toBe(before);});
  it('C03/C08 fresh-expired raw-body BLOCKED has neither result nor invented receipt',()=>{
    const body=JSON.stringify(request,null,2),f=fixture({status:'BLOCKED',reason:'REMOTE_BRIDGE_V2_REQUEST_EXPIRED',requestSha256:sha(body),completedAt:'2026-10-05T11:00:00.000Z'},body);f.expected.digest_branch='RAW_BODY_PRECLAIM_REJECTION';
    const r=readRBridgeGitHubCarrier(f.capture,f.expected);expect(r.kind).toBe('LEGACY_REJECTION');expect(r.status).toBe('BLOCKED');expect(r).not.toHaveProperty('receipt');expect(r).not.toHaveProperty('output');
    f.expected.digest_branch='ADMITTED_CANONICAL_REQUEST';expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');
  });
  it('C06 rehashing wrong author, URL, repository, issue, body or capture context does not authenticate',()=>{
    for(const change of [(f:ReturnType<typeof fixture>)=>{f.capture.comments[0]!.author='attacker';},(f:ReturnType<typeof fixture>)=>{f.capture.issue.author='attacker';},(f:ReturnType<typeof fixture>)=>{f.capture.repository='evil/repo';},(f:ReturnType<typeof fixture>)=>{f.capture.issue.number=18;},(f:ReturnType<typeof fixture>)=>{f.capture.comments[0]!.url='https://github.com/evil/repo/issues/17#issuecomment-1';},(f:ReturnType<typeof fixture>)=>{f.capture.issue.body+=' ';},(f:ReturnType<typeof fixture>)=>{f.capture.context_sha256='f'.repeat(64);}]){const f=fixture();change(f);reseal(f);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');}
  });
  it('C04 authenticates every complete chunk; missing, conflicting, corrupt and mixed chunks reject',()=>{
    const make=()=>{const value={path:'/mnt/data/fixture',text:'x'.repeat(100000)},f=fixture({status:'PASS',operationResult:value,resultSha256:sha(JSON.stringify(value))});const req={...request,operation:{kind:'FILE' as const,action:'READ' as const,target:'/mnt/data/fixture',args:{}}};f.capture.issue.body=JSON.stringify(req);f.expected.request_body_sha256=sha(f.capture.issue.body);f.envelope.requestSha256=remoteBridgeRequestV2Digest(req);chunks(f);return f;};
    const good=make();expect(readRBridgeGitHubCarrier(good.capture,good.expected).kind).toBe('LEGACY_RESULT');
    for(const change of [(f:ReturnType<typeof fixture>)=>{f.capture.comments.splice(0,1);},(f:ReturnType<typeof fixture>)=>{const c={...f.capture.comments[0]!,id:999,url:'https://github.com/fixture-owner/fixture/issues/17#issuecomment-999',body:f.capture.comments[0]!.body.replace('eHh4','eHh5')};f.capture.comments.push(c);},(f:ReturnType<typeof fixture>)=>{f.capture.comments[0]!.body=f.capture.comments[0]!.body.replace('"count": 3','"count": 4');}]){const f=make();change(f);reseal(f);expect(readRBridgeGitHubCarrier(f.capture,f.expected).kind).toBe('INVALID');}
  });
  it('raw JSON rejects duplicate keys, invalid UTF8, non-finite, depth and limits but preserves producer APP numbers',()=>{
    for(const raw of [Buffer.from('{"a":1,"a":2}'),Buffer.from([0xff]),Buffer.from('1e999'),Buffer.from('['.repeat(66)+'0'+']'.repeat(66))])expect(()=>parseRBridgeCarrierJson(raw,65536)).toThrow();
    expect(()=>parseRBridgeCarrierJson(Buffer.from('{}'),1)).toThrow();expect(parseRBridgeCarrierJson(Buffer.from('{"ns":1760000000000000000}'),65536)).toEqual({ns:1760000000000000000});
  });
});
