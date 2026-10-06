import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {readRBridgeMcpOutput,qualifyRBridgeReaders,createReferenceReaderRunner} from '../../src/installation/readerQualification.js';
import type {McpReadClient,McpReaderScope} from '../../src/installation/rbridge-installation-client.js';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue,RBridgeExecutionReceiptV1} from '../../src/domain/rbridgeExecutionContract.js';
import {fixture as githubFixture,core,rewrite,chunks,reseal,sha as carrierSha} from '../fixtures/rbridge-reader-carriers.js';
import {readRBridgeGitHubCarrier} from '../../src/installation/githubCarrierReader.js';
import type {ReaderFixture,ReaderRegistry} from '../../src/installation/readerQualification.js';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {createFixtureSdkReadClient,qualifyInstalledReaderRuntime} from '../../src/installation/rbridge-installation-client.js';
import {runRBridgeReadResult} from '../../src/cli/rbridgeReadResult.js';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {RBRIDGE_ENABLED_ACTIONS} from '../../src/domain/rbridgeCoreProtocol.js';
import {validateInstallContract} from '../../src/installation/types.js';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const scope:McpReaderScope={operationId:'fixture-read',principalId:'fixture-operator',targetInstanceId:'fixture-host',runtime_uid:1027,intent_sha256:'a'.repeat(64),policy_sha256:'b'.repeat(64),deadline_ms:5000};
function fixture(wrongWhole=false){
  const output={text:'fixture é'},bytes=Buffer.from(canonicalRBridgeJson(output));
  const receipt:RBridgeExecutionReceiptV1={schema:'RBRIDGE_EXECUTION_RECEIPT_V1',operationId:scope.operationId,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId,intentSha256:scope.intent_sha256,policy:{schema:'RBRIDGE_POLICY_SNAPSHOT_V1',mode:'SAFE',policyVersion:'safe-core-p2a-v1',policySha256:scope.policy_sha256,decision:'ALLOW'},phase:'TERMINAL',outcome:'PASS',resultSha256:wrongWhole?'f'.repeat(64):sha(bytes),cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:(['CLAIMED','AUTHORIZED','STARTING','RUNNING','TERMINAL'] as const).map(phase=>({phase,at:'2026-10-06T00:00:00.000Z'})),postconditions:[]};
  const calls:string[]=[],client:McpReadClient={scope:'FIXTURE_AUTHORITY_ONLY',sdk_package_version:'2.3.0',negotiated_protocol_version:'2026-07-28',protocol_era:'modern',async callTool(input){calls.push(input.name);let row:unknown;
    if(input.name==='rbridge_capabilities')row={schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:scope.principalId,targetInstanceId:scope.targetInstanceId,supportedKinds:['HEALTH','FILE','PROCESS','CHUNK'],enabledActions:['HEALTH/STATUS','FILE/READ'],policySha256:scope.policy_sha256,executionAvailable:true,executionStatus:'CORE_CONNECTED'};
    else if(input.name==='rbridge_status')row={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:{status:'RECEIPT',receipt}};
    else{const cursor=input.arguments.cursor as number,part=bytes.subarray(cursor,Math.min(cursor+5,bytes.length));row={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:{status:'RESULT',receipt,resultSha256:receipt.resultSha256,cursor,nextCursor:cursor+part.length,eof:cursor+part.length===bytes.length,dataBase64:part.toString('base64')}};}
    return {content:[{type:'text',text:JSON.stringify(row)}],structuredContent:row};
  }};
  return {client,calls,receipt,bytes,output};
}
describe('reader qualification and complete MCP output',()=>{
  it('reference C01–C09 matrix cannot stand in for named actual adoption; version and adoption drift invalidate it',async()=>{
    const plain=githubFixture(),positive=core(),terminal=core('FAIL'),large=githubFixture(),wrongDigest=core(),wrongAuthor=githubFixture(),replay=core(),absent=githubFixture();
    const req=JSON.parse(large.capture.issue.body) as {operation:unknown};req.operation={kind:'FILE',action:'READ',target:'/mnt/data/fixture',args:{}};large.capture.issue.body=JSON.stringify(req);large.expected.request_body_sha256=carrierSha(large.capture.issue.body);
    const operation={path:'/mnt/data/fixture',text:'x'.repeat(100000)};(large.envelope as Record<string,unknown>).operationResult=operation;(large.envelope as Record<string,unknown>).resultSha256=carrierSha(JSON.stringify(operation));
    const {remoteBridgeRequestV2Digest}=await import('../../src/domain/remoteBridgeStage2Protocol.js');(large.envelope as Record<string,unknown>).requestSha256=remoteBridgeRequestV2Digest(JSON.parse(large.capture.issue.body));chunks(large);
    (wrongDigest.envelope as Record<string,unknown>).resultSha256='e'.repeat(64);rewrite(wrongDigest);wrongAuthor.capture.issue.author='attacker';reseal(wrongAuthor);replay.expected.receipt_sha256=carrierSha(canonicalRBridgeJson(replay.receipt as unknown as RBridgeJsonValue));replay.expected.output_sha256=replay.receipt.resultSha256!;replay.expected.selected_comment_id=1;const duplicate=structuredClone(replay.capture.comments[0]!);duplicate.id=2;duplicate.url=duplicate.url.replace('issuecomment-1','issuecomment-2');replay.capture.comments.push(duplicate);reseal(replay);absent.capture.comments=[];reseal(absent);
    const cases:ReaderFixture[]=[plain,positive,terminal,large,wrongDigest,wrongAuthor,replay,absent].map((f,n)=>({fixture_id:'fixture-'+n,case_id:('C0'+(n+1)) as ReaderFixture['case_id'],transport:'GITHUB',provenance:'SYNTHETIC',...(n===6?{replayed_at:'2026-10-06T10:00:00.000Z'}:{}),capture:f.capture,expected:f.expected,expected_verdict_sha256:sha(JSON.stringify(readRBridgeGitHubCarrier(f.capture,f.expected)))}));
    const m=fixture(),verdict=await readRBridgeMcpOutput(m.client,scope);cases.push({fixture_id:'fixture-9',case_id:'C09',transport:'MCP',provenance:'SYNTHETIC',client:m.client,expected:scope,expected_verdict_sha256:sha(JSON.stringify(verdict))});
    const registration={reader_id:'github-reference',source_sha256:'d'.repeat(64),entrypoint:'/srv/fixture/rbridgeReadResult.js',version:'1',transport:'GITHUB' as const,trusted_context_sha256:'c'.repeat(64),qualification_sha256:'f'.repeat(64),adoption_sha256:'f'.repeat(64)},registry:ReaderRegistry={readers:[registration,{...registration,reader_id:'mcp-reference',transport:'MCP'}],adoptions:[]};
    const report=await qualifyRBridgeReaders(registry,{cases},createReferenceReaderRunner());expect(report.referenceAcceptance).toBe('PASS');expect(report.actualAcceptance).toBe('UNKNOWN');expect(report.acceptedCases).toEqual(['C01','C02','C03','C04','C05','C06','C07','C08','C09']);expect(report.invocations).toHaveLength(9);
    validateInstallContract(report,'ReaderQualificationReport');for(const row of report.invocations){expect(sha(row.input_json)).toBe(row.input_sha256);expect(sha(row.verdict_json)).toBe(row.output_sha256);}
    const mislabeled=cases.map(f=>f.case_id==='C02'?{...cases[0]!,fixture_id:f.fixture_id,case_id:f.case_id}:f);const wrongCase=await qualifyRBridgeReaders(registry,{cases:mislabeled},createReferenceReaderRunner());expect(wrongCase.actualAcceptance).toBe('FAIL');expect(wrongCase.reason_codes).toContain('READER_CASE_MEANING_INVALID');
    expect((await qualifyRBridgeReaders({...registry,readers:[{...registration,version:'wrong-version'}]},{cases},createReferenceReaderRunner())).actualAcceptance).toBe('FAIL');
    const adoption={schema:'RBRIDGE_READER_ADOPTION_V1' as const,reader_id:registration.reader_id,owner:'fixture-owner',workflow:'fixture-workflow',entrypoint:registration.entrypoint,source_sha256:'e'.repeat(64),version:'1',trusted_context_sha256:registration.trusted_context_sha256,fixture_set_sha256:'f'.repeat(64),adopted_at:'2026-10-06T00:00:00.000Z'};
    expect((await qualifyRBridgeReaders({...registry,adoptions:[adoption]},{cases},createReferenceReaderRunner())).actualAcceptance).toBe('FAIL');
  });
  it.each(['legacy','modern'] as const)('genuine official SDK records package and negotiated protocol separately (%s)',async era=>{
    const f=fixture(),[wire,serverWire]=InMemoryTransport.createLinkedPair(),handle=serveStdio(()=>createRBridgeMcpSafeServer({binding:{authenticatedSubject:'uid:1027',principalId:scope.principalId,targetInstanceId:scope.targetInstanceId},bindingProvider:async()=>({schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',runtimeUid:1027,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId,policySha256:scope.policy_sha256,enabledActions:RBRIDGE_ENABLED_ACTIONS}),core:{async submit(){throw new Error('READER_MUST_NOT_SUBMIT');},async status(){return {status:'RECEIPT',receipt:f.receipt};},async result(_id,cursor,maxBytes){const part=f.bytes.subarray(cursor,cursor+maxBytes);return {status:'RESULT',receipt:f.receipt,resultSha256:f.receipt.resultSha256!,cursor,nextCursor:cursor+part.length,eof:cursor+part.length===f.bytes.length,dataBase64:part.toString('base64')};},async requestCancel(){throw new Error('READER_MUST_NOT_CANCEL');}}}),{transport:serverWire,legacy:'serve'}),client=new Client({name:'fixture-read-only',version:'source-fixture'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});
    try{await client.connect(wire);const reader=await createFixtureSdkReadClient(client);const result=await readRBridgeMcpOutput(reader,scope);expect(result.status,JSON.stringify(result)).toBe('RESULT');expect(reader.sdk_package_version).toBe('2.3.0');expect(reader.protocol_era).toBe(era);expect(reader.negotiated_protocol_version).toBe(client.getNegotiatedProtocolVersion());expect(reader.scope).toBe('FIXTURE_AUTHORITY_ONLY');}
    finally{await client.close();await handle.close();}
  });
  it('source CLI and forged authority cannot impersonate the protected installed UID/runtime',async()=>{
    const profile=parseRBridgeInstallProfile(JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    await expect(qualifyInstalledReaderRuntime(profile,{} as never)).rejects.toThrow('READER_RUNTIME_UNQUALIFIED');
    const result=await runRBridgeReadResult({schema:'RBRIDGE_READER_INPUT_V1',operation:'QUALIFY_INSTALLED',profile,toolkit_manifest:{},registry:{readers:[],adoptions:[]},fixtures:{cases:[]}});expect(result).toMatchObject({status:'UNKNOWN',reason_codes:['READER_RUNTIME_UNQUALIFIED']});
  });
  it('reference parser cannot close an empty/unnamed actual-reader registry',async()=>{const report=await qualifyRBridgeReaders({readers:[],adoptions:[]},{cases:[]},createReferenceReaderRunner());expect(report.actualAcceptance).toBe('UNKNOWN');expect(report.reason_codes).toContain('READER_REGISTRY_EMPTY');});
  it('C09 consistent individually valid pages fail when concatenated whole-output SHA is wrong',async()=>{const f=fixture(true),r=await readRBridgeMcpOutput(f.client,scope);expect(r.status).toBe('INVALID');expect(r.reason_codes).toContain('MCP_READER_WHOLE_DIGEST_INVALID');expect(f.calls).not.toContain('rbridge_submit');});
  it('concatenates byte cursors across split UTF8 and verifies original receipt and canonical JSON',async()=>{const f=fixture(),r=await readRBridgeMcpOutput(f.client,{...scope,receipt_sha256:sha(canonicalRBridgeJson(f.receipt as unknown as RBridgeJsonValue)),output_sha256:f.receipt.resultSha256!});expect(r.status).toBe('RESULT');if(r.status==='RESULT')expect(r.output).toEqual(f.output);expect(f.calls.filter(x=>x==='rbridge_result').length).toBeGreaterThan(1);expect(f.calls).not.toContain('rbridge_submit');});
  it('spoofed installed-client scope, wrong binding/version, changed receipt and partial framing stay invalid',async()=>{
    for(const change of [(f:ReturnType<typeof fixture>)=>{f.client.scope='QUALIFIED_INSTALLED_MCP_CLIENT';},(f:ReturnType<typeof fixture>)=>{f.client.sdk_package_version='unobserved';},(f:ReturnType<typeof fixture>)=>{f.receipt.principalId='attacker';},(f:ReturnType<typeof fixture>)=>{f.receipt.policy.policySha256='e'.repeat(64);}]){const f=fixture();change(f);expect((await readRBridgeMcpOutput(f.client,scope)).status).toBe('INVALID');}
  });
  it('preserves NOT_FOUND, NOT_READY and terminal no-output without any resubmission',async()=>{
    for(const status of ['NOT_FOUND','NOT_READY','TERMINAL'] as const){
      const f=fixture();delete f.receipt.resultSha256;
      if(status==='NOT_READY'){f.receipt.phase='RUNNING';delete f.receipt.outcome;f.receipt.transitions=f.receipt.transitions.slice(0,-1);}else f.receipt.outcome='FAIL';
      const original=f.client.callTool;f.client.callTool=async(input,options)=>input.name==='rbridge_status'?{content:[{type:'text',text:JSON.stringify({schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:status==='NOT_FOUND'?{status:'NOT_FOUND',operationId:scope.operationId,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId}:{status:'RECEIPT',receipt:f.receipt}})}],structuredContent:{schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,result:status==='NOT_FOUND'?{status:'NOT_FOUND',operationId:scope.operationId,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId}:{status:'RECEIPT',receipt:f.receipt}}}:original(input,options);
      const r=await readRBridgeMcpOutput(f.client,scope);expect(r.status).toBe(status);expect(r).not.toHaveProperty('output');expect(f.calls).not.toContain('rbridge_submit');
    }
  });
  it('conflicting structured/text frames, altered SDK metadata and an ignored abort deadline cannot pass',async()=>{
    for(const change of [(row:Record<string,unknown>)=>{row.structuredContent={wrong:true};},(row:Record<string,unknown>)=>{row._meta={'io.modelcontextprotocol/serverInfo':{name:'attacker',version:'0.1.0-dev'}};}]){const f=fixture(),original=f.client.callTool;f.client.callTool=async(input,options)=>{const response=await original(input,options) as Record<string,unknown>;change(response);return response;};expect((await readRBridgeMcpOutput(f.client,scope)).status).toBe('INVALID');}
    const f=fixture();f.client.callTool=()=>new Promise(()=>{});const r=await readRBridgeMcpOutput(f.client,{...scope,deadline_ms:10});expect(r.status).toBe('UNAVAILABLE');expect(r.reason_codes).toContain('MCP_READER_DEADLINE');
  });
  it('retains exact read-only query/response preimages for independent replay',async()=>{const f=fixture(),r=await readRBridgeMcpOutput(f.client,scope);expect(r.query_evidence).toHaveLength(f.calls.length);for(const row of r.query_evidence??[]){expect(sha(row.response_json)).toBe(row.response_sha256);expect(['rbridge_capabilities','rbridge_status','rbridge_result']).toContain(row.name);expect(()=>JSON.parse(row.arguments_json)).not.toThrow();}});
  it('a source-format blocked/uncertain query remains unavailable with exact scope',async()=>{for(const status of ['BLOCKED','UNCERTAIN']){const f=fixture(),original=f.client.callTool;f.client.callTool=async(input,options)=>{if(input.name!=='rbridge_status')return original(input,options);const row={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:input.name,operationId:scope.operationId,principalId:scope.principalId,targetInstanceId:scope.targetInstanceId,status,reason:status==='BLOCKED'?'RBRIDGE_MCP_CORE_UNAVAILABLE':'RBRIDGE_MCP_CORE_RESULT_UNKNOWN'};return {content:[{type:'text',text:JSON.stringify(row)}],structuredContent:row,isError:true};};expect((await readRBridgeMcpOutput(f.client,scope)).status).toBe('UNAVAILABLE');}});
  it('fixed source CLI rejects duplicate input keys, extra arguments and unregistered operations',()=>{
    const entry=new URL('../../src/cli/rbridgeReadResult.ts',import.meta.url).pathname;
    for(const [input,args] of [['{"schema":"RBRIDGE_READER_INPUT_V1","schema":"other"}',[]],[JSON.stringify({schema:'RBRIDGE_READER_INPUT_V1',operation:'SHELL'}),[]],[JSON.stringify({schema:'RBRIDGE_READER_INPUT_V1',operation:'QUALIFY_REFERENCE',registry:{readers:[],adoptions:[]},fixtures:{cases:[]}}),['arbitrary']] ] as const){const result=spawnSync(process.execPath,['--import','tsx',entry,...args],{input,encoding:'utf8',timeout:10000,maxBuffer:65536});expect(result.status).toBe(2);expect(JSON.parse(result.stdout)).toMatchObject({status:'UNKNOWN',reason_codes:['READER_CLI_INPUT_INVALID']});}
    const result=spawnSync(process.execPath,['--import','tsx',entry],{input:JSON.stringify({schema:'RBRIDGE_READER_INPUT_V1',operation:'QUALIFY_REFERENCE',registry:{readers:[],adoptions:[]},fixtures:{cases:[]}}),encoding:'utf8',timeout:10000,maxBuffer:65536});expect(result.status).toBe(2);expect(JSON.parse(result.stdout)).toMatchObject({referenceAcceptance:'UNKNOWN',actualAcceptance:'UNKNOWN'});
  });
});
