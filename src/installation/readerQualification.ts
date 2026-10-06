import {createHash} from 'node:crypto';
import {canonicalRBridgeJson,parseRBridgeCoreLookupResult,parseRBridgeCoreResultPage,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import {RBRIDGE_ENABLED_ACTIONS} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionReceiptV1,RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import {parseRBridgeCarrierJson} from './carrierJson.js';
import {readRBridgeGitHubCarrier} from './githubCarrierReader.js';
import type {CarrierCapture,ReaderExpectation} from './rbridge-installation-reader.js';
import {assertInstalledMcpReaderScope,isInstalledMcpReadClient,isInstalledReaderAuthority,verifyInstalledReaderAuthority,type InstalledReaderAuthority,type McpReadClient,type McpReaderScope} from './rbridge-installation-client.js';
import {installHash} from './gateContext.js';
import {validateInstallContract,type ReaderRegistration} from './types.js';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>canonicalRBridgeJson(v as RBridgeJsonValue),hash=(v:unknown)=>sha(canonical(v));
function fail(reason:string):never{throw new Error(reason);}
function object(v:unknown){if(!v||typeof v!=='object'||Array.isArray(v))fail('MCP_READER_FIELDS_INVALID');return v as Record<string,unknown>;}
function fields(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]){if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail('MCP_READER_FIELDS_INVALID');}
export interface McpQueryEvidence{name:string;arguments_json:string;response_json:string;response_sha256:string;}
export type McpReaderResult={scope:'REFERENCE_MCP_READ';status:'RESULT'|'TERMINAL'|'NOT_READY'|'NOT_FOUND'|'UNAVAILABLE'|'INVALID';reason_codes:readonly string[];receipt?:RBridgeExecutionReceiptV1;output?:unknown;output_sha256?:string;raw_output_base64?:string;response_sha256?:readonly string[];query_evidence:readonly McpQueryEvidence[];sdk_package_version?:string;negotiated_protocol_version?:string;protocol_era?:'legacy'|'modern';};
export async function readRBridgeMcpOutput(client:McpReadClient,scope:McpReaderScope):Promise<McpReaderResult>{
  const responseHashes:string[]=[],queryEvidence:McpQueryEvidence[]=[],base={scope:'REFERENCE_MCP_READ' as const,query_evidence:queryEvidence};let evidenceBytes=0;
  try{
    validateInstallContract(scope,'McpReaderScope');
    if(client.scope!=='FIXTURE_AUTHORITY_ONLY'&&(client.scope!=='QUALIFIED_INSTALLED_MCP_CLIENT'||!isInstalledMcpReadClient(client)))fail('MCP_READER_CLIENT_UNQUALIFIED');
    if(isInstalledMcpReadClient(client))assertInstalledMcpReaderScope(client,scope);
    if(client.sdk_package_version!=='2.3.0'||!['legacy','modern'].includes(client.protocol_era)||(client.protocol_era==='modern'?client.negotiated_protocol_version!=='2026-07-28':!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(client.negotiated_protocol_version)))fail('MCP_READER_VERSION_INVALID');
    const signal=AbortSignal.timeout(scope.deadline_ms),deadline=performance.now()+scope.deadline_ms;
    async function query(name:Parameters<McpReadClient['callTool']>[0]['name'],args:Record<string,unknown>){
      const remaining=deadline-performance.now();if(signal.aborted||remaining<=0)fail('MCP_READER_DEADLINE');let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const result=object(await Promise.race([client.callTool({name,arguments:args},{signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MCP_READER_DEADLINE')),remaining);})]));
        fields(result,['content','structuredContent'],['isError','_meta']);if(Object.hasOwn(result,'isError')&&typeof result.isError!=='boolean')fail('MCP_READER_FRAME_INVALID');
        if(Object.hasOwn(result,'_meta')){const meta=object(result._meta);fields(meta,['io.modelcontextprotocol/serverInfo']);const info=object(meta['io.modelcontextprotocol/serverInfo']);fields(info,['name','version']);if(info.name!=='rbridge'||info.version!=='0.1.0-dev')fail('MCP_READER_SERVER_METADATA_INVALID');}
        if(!Array.isArray(result.content)||result.content.length!==1)fail('MCP_READER_FRAME_INVALID');const content=object(result.content[0]);fields(content,['type','text']);if(content.type!=='text'||typeof content.text!=='string')fail('MCP_READER_FRAME_INVALID');
        const row=object(parseRBridgeCarrierJson(Buffer.from(content.text),131072));const argumentsJson=JSON.stringify(args);evidenceBytes+=Buffer.byteLength(content.text)+Buffer.byteLength(argumentsJson);if(evidenceBytes>67108864)fail('MCP_READER_EVIDENCE_LIMIT');queryEvidence.push({name,arguments_json:argumentsJson,response_json:content.text,response_sha256:sha(content.text)});if(canonical(row)!==canonical(result.structuredContent))fail('MCP_READER_FRAME_CONFLICT');responseHashes.push(sha(content.text));
        return {row,isError:result.isError===true};
      }finally{clearTimeout(timer);}
    }
    async function capabilities(){
      const {row:r,isError}=await query('rbridge_capabilities',{});fields(r,['schema','mode','principalId','targetInstanceId','supportedKinds','enabledActions','executionAvailable','executionStatus'],['policySha256','reason']);
      if(r.schema!=='RBRIDGE_MCP_CAPABILITIES_V1'||r.mode!=='SAFE'||r.principalId!==scope.principalId||r.targetInstanceId!==scope.targetInstanceId||JSON.stringify(r.supportedKinds)!=='["HEALTH","FILE","PROCESS","CHUNK"]'||!Array.isArray(r.enabledActions)||new Set(r.enabledActions).size!==r.enabledActions.length||r.enabledActions.some(k=>!RBRIDGE_ENABLED_ACTIONS.includes(k as typeof RBRIDGE_ENABLED_ACTIONS[number]))||typeof r.executionAvailable!=='boolean')fail('MCP_READER_BINDING_INVALID');
      if(!r.executionAvailable){if(r.executionStatus!=='BLOCKED'||r.enabledActions.length||Object.hasOwn(r,'policySha256'))fail('MCP_READER_BINDING_INVALID');fail('MCP_READER_OWNER_UNAVAILABLE');}
      if(isError||r.executionStatus!=='CORE_CONNECTED'||r.policySha256!==scope.policy_sha256||Object.hasOwn(r,'reason'))fail('MCP_READER_BINDING_INVALID');return r;
    }
    const capability=await capabilities();
    async function core(name:'rbridge_status'|'rbridge_result',args:Record<string,unknown>){
      const {row:r,isError}=await query(name,args);if(r.schema!=='RBRIDGE_MCP_CORE_QUERY_RESULT_V1'||r.tool!==name)fail('MCP_READER_BINDING_INVALID');
      if(Object.hasOwn(r,'result')){fields(r,['schema','tool','result']);if(isError)fail('MCP_READER_QUERY_UNAVAILABLE');return r.result;}
      fields(r,['schema','tool','operationId','principalId','targetInstanceId','status','reason']);if(r.operationId!==scope.operationId||r.principalId!==scope.principalId||r.targetInstanceId!==scope.targetInstanceId||!isError||!['BLOCKED','UNCERTAIN'].includes(String(r.status))||!['RBRIDGE_MCP_ABORTED_BEFORE_QUERY','RBRIDGE_MCP_CORE_NOT_CONFIGURED','RBRIDGE_MCP_CORE_UNAVAILABLE','RBRIDGE_MCP_CORE_RESULT_UNKNOWN'].includes(String(r.reason)))fail('MCP_READER_BINDING_INVALID');fail('MCP_READER_QUERY_UNAVAILABLE');
    }
    const found=parseRBridgeCoreLookupResult(await core('rbridge_status',{operationId:scope.operationId}),scope);
    const metadata={sdk_package_version:client.sdk_package_version,negotiated_protocol_version:client.negotiated_protocol_version,protocol_era:client.protocol_era};
    if(found.status==='NOT_FOUND')return {...base,status:'NOT_FOUND',reason_codes:[],response_sha256:responseHashes,...metadata};
    const receipt=parseRBridgeExecutionReceipt(found.receipt,scope,scope.intent_sha256),receiptSHA=hash(receipt);
    if(receipt.policy.policySha256!==scope.policy_sha256||(scope.receipt_sha256&&scope.receipt_sha256!==receiptSHA))fail('MCP_READER_RECEIPT_INVALID');
    if(receipt.phase!=='TERMINAL'){if(receipt.resultSha256||scope.output_sha256)fail('MCP_READER_RECEIPT_INVALID');return {...base,status:'NOT_READY',reason_codes:[],receipt,response_sha256:responseHashes,...metadata};}
    if(!receipt.resultSha256){if(receipt.outcome==='PASS'||scope.output_sha256)fail('MCP_READER_OUTPUT_MISSING');return {...base,status:'TERMINAL',reason_codes:[],receipt,response_sha256:responseHashes,...metadata};}
    const parts:Buffer[]=[];let cursor=0,eof=false;
    for(let n=0;n<=8388608/32768&&!eof;n++){
      const page=parseRBridgeCoreResultPage(await core('rbridge_result',{operationId:scope.operationId,cursor,maxBytes:32768}),scope,cursor,32768);
      if(page.status!=='RESULT'||hash(page.receipt)!==receiptSHA||page.resultSha256!==receipt.resultSha256)fail('MCP_READER_PAGE_RECEIPT_INVALID');parts.push(Buffer.from(page.dataBase64,'base64'));cursor=page.nextCursor;eof=page.eof;
    }
    if(!eof)fail('MCP_READER_PAGE_LIMIT');const bytes=Buffer.concat(parts,cursor);if(sha(bytes)!==receipt.resultSha256||(scope.output_sha256&&sha(bytes)!==scope.output_sha256))fail('MCP_READER_WHOLE_DIGEST_INVALID');
    const output=parseRBridgeCarrierJson(bytes,8388608);if(!bytes.equals(Buffer.from(canonical(output))))fail('MCP_READER_CANONICAL_OUTPUT_INVALID');
    const final=parseRBridgeCoreLookupResult(await core('rbridge_status',{operationId:scope.operationId}),scope);if(final.status!=='RECEIPT'||hash(final.receipt)!==receiptSHA||hash(await capabilities())!==hash(capability))fail('MCP_READER_FINAL_IDENTITY_CHANGED');
    return {...base,status:'RESULT',reason_codes:[],receipt,output,output_sha256:receipt.resultSha256,raw_output_base64:bytes.toString('base64'),response_sha256:responseHashes,...metadata};
  }catch(error){const reason=error instanceof Error&&/^MCP_READER_[A-Z_]+$/.test(error.message)?error.message:'MCP_READER_INPUT_INVALID';return {...base,status:['MCP_READER_DEADLINE','MCP_READER_OWNER_UNAVAILABLE','MCP_READER_QUERY_UNAVAILABLE'].includes(reason)?'UNAVAILABLE':'INVALID',reason_codes:[reason]};}
}
export interface ReaderAdoption{schema:'RBRIDGE_READER_ADOPTION_V1';reader_id:string;owner:string;workflow:string;entrypoint:string;source_sha256:string;version:string;trusted_context_sha256:string;fixture_set_sha256:string;adopted_at:string;}
export interface ReaderRegistry{readers:readonly ReaderRegistration[];adoptions:readonly ReaderAdoption[];}
export type ReaderFixture={fixture_id:string;case_id:'C01'|'C02'|'C03'|'C04'|'C05'|'C06'|'C07'|'C08'|'C09';provenance:'AUTHENTIC_ARCHIVE'|'SOURCE_PRODUCER'|'SYNTHETIC';expected_verdict_sha256:string;replayed_at?:string}&({transport:'GITHUB';capture:CarrierCapture;expected:ReaderExpectation}|{transport:'MCP';client:McpReadClient;expected:McpReaderScope});
export interface ReaderFixtureSet{cases:readonly ReaderFixture[];}
function assertCaseMeaning(f:ReaderFixture,value:unknown){
  const v=object(value);let valid=false;
  if(f.transport==='MCP')valid=f.case_id==='C09'&&v.status==='RESULT'&&typeof v.output_sha256==='string'&&typeof v.raw_output_base64==='string'&&Array.isArray(v.query_evidence)&&v.query_evidence.length>0;
  else{
    const e=f.expected,c=f.capture;
    switch(f.case_id){
      case 'C01':valid=e.mode==='LEGACY'&&v.kind==='LEGACY_RESULT'&&v.status==='PASS';break;
      case 'C02':valid=e.mode==='CORE'&&v.kind==='CORE_RESULT'&&v.status==='PASS';break;
      case 'C03':valid=e.mode==='CORE'&&v.kind==='CORE_RESULT'&&['FAIL','BLOCKED','UNCERTAIN'].includes(String(v.status));break;
      case 'C04':valid=v.kind==='LEGACY_RESULT'||v.kind==='CORE_RESULT';valid=valid&&v.status==='PASS'&&!!v.evidence&&Buffer.from(String(object(v.evidence).raw_envelope_base64),'base64').length>60000&&c.comments.some(row=>row.body.includes('"schema": "COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1"'));break;
      case 'C05':valid=v.kind==='INVALID'&&Array.isArray(v.reason_codes)&&v.reason_codes.some(r=>String(r).includes('DIGEST')||String(r).includes('SHA'));break;
      case 'C06':valid=v.kind==='INVALID'&&(c.issue.author!==e.author||c.repository!==e.repository||c.viewer!==e.author||c.comments.some(row=>row.author!==e.author));break;
      case 'C07':{const request=object(parseRBridgeCarrierJson(Buffer.from(c.issue.body),65536)),replayed=f.replayed_at?new Date(f.replayed_at):undefined;valid=!!replayed&&Number.isFinite(replayed.getTime())&&replayed.toISOString()===f.replayed_at&&replayed.getTime()>Date.parse(String(request.expiresAt))&&e.mode==='CORE'&&v.kind==='CORE_RESULT'&&v.status==='PASS'&&c.issue.state==='CLOSED'&&!!e.receipt_sha256&&!!e.output_sha256&&!!e.selected_comment_id&&object(v.evidence).selected_comment_id===e.selected_comment_id&&c.comments.filter(row=>row.body===c.comments.find(row=>row.id===e.selected_comment_id)?.body).length>1;break;}
      case 'C08':valid=v.kind==='UNAVAILABLE'&&v.status==='UNKNOWN'&&c.comments.length===0;break;
    }
  }
  if(!valid)fail('READER_CASE_MEANING_INVALID');
}
export interface ReaderInvocation{source_sha256:string;version:string;trusted_context_sha256:string;verdict:unknown;input_sha256:string;output_sha256:string;scope:'REFERENCE_PARSER_ONLY'|'QUALIFIED_INSTALLED_READER';}
export interface RegisteredReaderRunner{invoke(registration:ReaderRegistration,fixture:ReaderFixture):Promise<ReaderInvocation>;}
const installedRunners=new WeakSet<object>();
const fixtureInput=(f:ReaderFixture)=>f.transport==='GITHUB'?{capture:f.capture,expected:f.expected,...(f.replayed_at?{replayed_at:f.replayed_at}:{})}:{expected:f.expected,sdk_package_version:f.client.sdk_package_version,negotiated_protocol_version:f.client.negotiated_protocol_version,protocol_era:f.client.protocol_era};
export const readerFixtureInputJson=(fixture:ReaderFixture):string=>JSON.stringify(fixtureInput(fixture));
export function createReferenceReaderRunner():RegisteredReaderRunner{return {async invoke(registration,fixture){const verdict=fixture.transport==='GITHUB'?readRBridgeGitHubCarrier(fixture.capture,fixture.expected):await readRBridgeMcpOutput(fixture.client,fixture.expected);return {scope:'REFERENCE_PARSER_ONLY',source_sha256:registration.source_sha256,version:'1',trusted_context_sha256:registration.trusted_context_sha256,verdict,input_sha256:sha(JSON.stringify(fixtureInput(fixture))),output_sha256:sha(JSON.stringify(verdict))};}};}
export async function createInstalledReaderRunner(authority:InstalledReaderAuthority):Promise<RegisteredReaderRunner>{
  if(!isInstalledReaderAuthority(authority))fail('READER_RUNNER_UNQUALIFIED');await verifyInstalledReaderAuthority(authority);
  const runner:RegisteredReaderRunner={async invoke(registration,fixture){
    const pinned=authority.profile.readers.find(r=>r.reader_id===registration.reader_id);if(!pinned||installHash(pinned)!==installHash(registration)||registration.entrypoint!==authority.entrypoint||registration.source_sha256!==authority.entrypoint_sha256||registration.version!==authority.version||fixture.transport!==registration.transport)fail('READER_REGISTRATION_DRIFT');
    if(fixture.transport==='MCP'&&!isInstalledMcpReadClient(fixture.client))fail('READER_ACTUAL_MCP_CLIENT_REQUIRED');
    const result=await createReferenceReaderRunner().invoke(registration,fixture);await verifyInstalledReaderAuthority(authority);return {...result,source_sha256:authority.entrypoint_sha256,version:authority.version,scope:'QUALIFIED_INSTALLED_READER'};
  }};installedRunners.add(runner);return Object.freeze(runner);
}
export interface ReaderQualificationReport{schema:'RBRIDGE_READER_QUALIFICATION_V1';referenceAcceptance:'PASS'|'FAIL'|'UNKNOWN';actualAcceptance:'PASS'|'FAIL'|'UNKNOWN';reason_codes:readonly string[];acceptedCases:readonly string[];invocations:readonly {reader_id:string;fixture_id:string;case_id:string;input_sha256:string;output_sha256:string;input_json:string;verdict_json:string;scope:string}[];}
export async function qualifyRBridgeReaders(registry:ReaderRegistry,fixtures:ReaderFixtureSet,runner:RegisteredReaderRunner):Promise<ReaderQualificationReport>{
  const reports:ReaderQualificationReport['invocations'][number][]=[],reasons=new Set<string>(),accepted=new Set<string>();let reference:'PASS'|'FAIL'|'UNKNOWN'='PASS',actual:'PASS'|'FAIL'|'UNKNOWN'='PASS';const deadline=performance.now()+180000;let reportBytes=0;
  try{
    if(!Array.isArray(registry.readers)||!registry.readers.length){reasons.add('READER_REGISTRY_EMPTY');reference='UNKNOWN';actual='UNKNOWN';}
    if(!installedRunners.has(runner)){reasons.add('READER_ACTUAL_INVOCATION_UNQUALIFIED');actual='UNKNOWN';}
    validateInstallContract(registry,'ReaderRegistry');
    if(registry.readers.length>64||registry.adoptions.length>64||fixtures.cases.length>512||new Set(registry.readers.map(r=>r.reader_id)).size!==registry.readers.length||new Set(fixtures.cases.map(f=>f.fixture_id)).size!==fixtures.cases.length||new Set(registry.adoptions.map(a=>a.reader_id)).size!==registry.adoptions.length||registry.adoptions.some(a=>!registry.readers.some(r=>r.reader_id===a.reader_id)))fail('READER_REGISTRY_INVALID');
    if(!registry.readers.some(r=>r.transport==='GITHUB')||!registry.readers.some(r=>r.transport==='MCP')){reasons.add('READER_TRANSPORT_ROSTER_INCOMPLETE');actual='UNKNOWN';}
    for(const reader of registry.readers){
      validateInstallContract(reader,'ReaderRegistration');const applicable=reader.transport==='GITHUB'?['C01','C02','C03','C04','C05','C06','C07','C08']:['C09'],cases=fixtures.cases.filter(f=>f.transport===reader.transport),adoption=registry.adoptions.filter(a=>a.reader_id===reader.reader_id);
      if(applicable.some(id=>!cases.some(f=>f.case_id===id))){reasons.add('READER_CASE_MATRIX_INCOMPLETE');reference='UNKNOWN';actual='UNKNOWN';}
      const fixtureSetSHA=installHash(cases.map(f=>({fixture_id:f.fixture_id,case_id:f.case_id,provenance:f.provenance,expected_verdict_sha256:f.expected_verdict_sha256,input_sha256:sha(JSON.stringify(fixtureInput(f)))})));
      if(adoption.length!==1){reasons.add('READER_ADOPTION_UNKNOWN');actual='UNKNOWN';}
      else{
        const a=adoption[0]!;validateInstallContract(a,'ReaderAdoption');if(installHash(a)!==reader.adoption_sha256||a.entrypoint!==reader.entrypoint||a.source_sha256!==reader.source_sha256||a.version!==reader.version||a.trusted_context_sha256!==reader.trusted_context_sha256||a.fixture_set_sha256!==fixtureSetSHA)fail('READER_ADOPTION_DRIFT');
        if(!Number.isFinite(Date.parse(a.adopted_at))||new Date(a.adopted_at).toISOString()!==a.adopted_at)fail('READER_ADOPTION_INVALID');
      }
      if(reader.transport==='GITHUB'&&!cases.some(f=>f.transport==='GITHUB'&&f.case_id==='C01'&&f.provenance==='AUTHENTIC_ARCHIVE'&&f.capture.scope==='AUTHENTICATED_GITHUB_READ')){reasons.add('READER_AUTHENTIC_ARCHIVE_UNKNOWN');actual='UNKNOWN';}
      if(reader.transport==='MCP'&&(!cases.some(f=>f.transport==='MCP'&&f.client.protocol_era==='legacy')||!cases.some(f=>f.transport==='MCP'&&f.client.protocol_era==='modern'))){reasons.add('READER_MCP_CLIENT_MATRIX_INCOMPLETE');actual='UNKNOWN';}
      const own=[];
      for(const f of cases){
        if(!applicable.includes(f.case_id)||!f.fixture_id||!['AUTHENTIC_ARCHIVE','SOURCE_PRODUCER','SYNTHETIC'].includes(f.provenance)||!/^[0-9a-f]{64}$/.test(f.expected_verdict_sha256))fail('READER_FIXTURE_INVALID');
        const remaining=deadline-performance.now();if(remaining<=0)fail('READER_QUALIFICATION_DEADLINE');let timer:ReturnType<typeof setTimeout>|undefined;let invocation:ReaderInvocation;try{invocation=await Promise.race([runner.invoke(reader,f),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('READER_QUALIFICATION_DEADLINE')),remaining);})]);}finally{clearTimeout(timer);}
        if(invocation.source_sha256!==reader.source_sha256||invocation.version!==reader.version||invocation.trusted_context_sha256!==reader.trusted_context_sha256||invocation.input_sha256!==sha(JSON.stringify(fixtureInput(f)))||invocation.output_sha256!==sha(JSON.stringify(invocation.verdict))||invocation.output_sha256!==f.expected_verdict_sha256)fail('READER_INVOCATION_DRIFT');
        assertCaseMeaning(f,invocation.verdict);if(invocation.scope!=='QUALIFIED_INSTALLED_READER')actual='UNKNOWN';
        const row={reader_id:reader.reader_id,fixture_id:f.fixture_id,case_id:f.case_id,input_sha256:invocation.input_sha256,output_sha256:invocation.output_sha256,input_json:JSON.stringify(fixtureInput(f)),verdict_json:JSON.stringify(invocation.verdict),scope:invocation.scope};reportBytes+=Buffer.byteLength(JSON.stringify(row));if(reportBytes>67108864)fail('READER_QUALIFICATION_EVIDENCE_LIMIT');reports.push(row);own.push(row);accepted.add(f.case_id);
      }
      if(installedRunners.has(runner)&&installHash(own)!==reader.qualification_sha256)fail('READER_QUALIFICATION_DRIFT');
    }
  }catch(error){reference='FAIL';actual='FAIL';reasons.add(error instanceof Error&&/^READER_[A-Z_]+$/.test(error.message)?error.message:'READER_QUALIFICATION_UNAVAILABLE');}
  const result:ReaderQualificationReport={schema:'RBRIDGE_READER_QUALIFICATION_V1',referenceAcceptance:reference,actualAcceptance:actual,reason_codes:[...reasons].sort(),acceptedCases:[...accepted].sort(),invocations:reports};validateInstallContract(result,'ReaderQualificationReport');return result;
}
