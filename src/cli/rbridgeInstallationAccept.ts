import {createHash} from 'node:crypto';
import {parseRemoteBridgeRequestV2} from '../domain/remoteBridgeStage2Protocol.js';
import {canonicalRBridgeJson} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import {readRBridgeGitHubCarrier} from '../installation/githubCarrierReader.js';
import {readRBridgeMcpOutput} from '../installation/readerQualification.js';
import {isInstalledMcpReadClient,type McpReadClient} from '../installation/rbridge-installation-client.js';
import type {CarrierCapture,ReaderExpectation} from '../installation/rbridge-installation-reader.js';
import {installHash} from '../installation/gateContext.js';
import {encodeInstallReport,parseRBridgeInstallProfile,type InstallProfile} from '../installation/types.js';

export interface InstallAcceptanceCase{kind:'HEALTH'|'FILE';capture:CarrierCapture;expected:ReaderExpectation;client:McpReadClient;}
export interface InstallAcceptanceInput{profile:InstallProfile;stage:'ORIGINAL'|'REPLAY';captured_at:string;canary_base64:string;cases:readonly InstallAcceptanceCase[];original?:InstallAcceptanceReport;}
export interface InstallAcceptedOperation{operation_id:string;kind:'HEALTH'|'FILE';receipt_sha256:string;output_sha256:string;comment_id:number;request_sha256:string;input_json:string;github_verdict_json:string;mcp_verdict_json:string;}
export interface InstallAcceptanceReport{schema:'RBRIDGE_INSTALL_READER_ACCEPTANCE_V1';scope:'REFERENCE_ACCEPTANCE_ONLY';status:'PASS'|'FAIL'|'UNKNOWN';accepted:false;actual_mcp_readers:boolean;profile_sha256:string;stage:'ORIGINAL'|'REPLAY';captured_at:string;operations:InstallAcceptedOperation[];reason_codes:string[];sha256:string;}
const sourceProfiles=new WeakSet<object>();
export function createSourceAcceptanceProfile(value:InstallProfile):InstallProfile{
  const p=structuredClone(parseRBridgeInstallProfile(value)),uid=process.getuid?.(),gid=process.getgid?.();
  if(uid===undefined||gid===undefined||uid<=0||process.geteuid?.()!==uid)fail('ACCEPTANCE_SOURCE_NONROOT_REQUIRED');
  p.binding={...p.binding,uid,gid,mcp_subject:'uid:'+uid};
  const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};freeze(p);sourceProfiles.add(p);return p;
}
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const innerHash=(v:unknown)=>sha(canonicalRBridgeJson(v as RBridgeJsonValue));
function fail(code:string):never{throw new Error(code);}
function timestamp(value:string){const parsed=new Date(value);if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==value)fail('ACCEPTANCE_TIME_INVALID');return parsed;}
function canaryBytes(value:string){
  if(typeof value!=='string'||value.length>5464||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('ACCEPTANCE_CANARY_INVALID');
  const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>4096||bytes.toString('base64')!==value||!Buffer.from(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).equals(bytes))fail('ACCEPTANCE_CANARY_INVALID');return bytes;
}

/** Read-only result comparison. Root orchestration separately proves installation,
 * authenticated capture origin, named reader adoption and helper settlement.
 * A reference verdict never becomes accepted installation through scope labels.
 */
export async function acceptRBridgeInstallation(input:InstallAcceptanceInput):Promise<InstallAcceptanceReport>{
  const report:InstallAcceptanceReport={schema:'RBRIDGE_INSTALL_READER_ACCEPTANCE_V1',scope:'REFERENCE_ACCEPTANCE_ONLY',status:'UNKNOWN',accepted:false,actual_mcp_readers:false,profile_sha256:'0'.repeat(64),stage:input?.stage==='REPLAY'?'REPLAY':'ORIGINAL',captured_at:typeof input?.captured_at==='string'?input.captured_at:'1970-01-01T00:00:00.000Z',operations:[],reason_codes:[],sha256:''};
  try{
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['profile','stage','captured_at','canary_base64','cases','original'].includes(k)))fail('ACCEPTANCE_INPUT_INVALID');
    const p=sourceProfiles.has(input.profile)?input.profile:parseRBridgeInstallProfile(input.profile),now=timestamp(input.captured_at),canary=canaryBytes(input.canary_base64);report.profile_sha256=installHash(p);
    if(sha(canary)!==p.service.canary_sha256||!['ORIGINAL','REPLAY'].includes(input.stage)||!Array.isArray(input.cases)||input.cases.length!==2||input.cases[0]?.kind!=='HEALTH'||input.cases[1]?.kind!=='FILE')fail('ACCEPTANCE_INPUT_INVALID');
    if(new Set(input.cases.map(c=>c.expected.request_id)).size!==2||new Set(input.cases.map(c=>c.expected.issue_number)).size!==2)fail('ACCEPTANCE_IDENTITY_REUSED');
    let original:InstallAcceptanceReport|undefined;
    if(input.stage==='REPLAY'){
      original=input.original;
      if(!original||original.schema!==report.schema||original.scope!=='REFERENCE_ACCEPTANCE_ONLY'||original.accepted!==false||original.status!=='PASS'||original.stage!=='ORIGINAL'||original.profile_sha256!==report.profile_sha256||original.operations.length!==2||original.reason_codes.length||original.sha256!==installHash({...original,sha256:''}))fail('ACCEPTANCE_ORIGINAL_TRUTH_MISSING');
    }else if(input.original!==undefined)fail('ACCEPTANCE_INPUT_INVALID');
    // Validate both predeclared operations before issuing any MCP query.
    const requests=input.cases.map((c,index)=>{
      const e=c.expected;
      if(e.mode!=='CORE'||e.expected_source_sha!==p.runtime.source_sha||e.repository!==p.binding.repository||e.author!==p.binding.author||e.runtime_uid!==p.binding.uid||e.scope?.operationId!==e.request_id||e.scope.principalId!==p.binding.principal_id||e.scope.targetInstanceId!==p.binding.target_instance_id||e.policy_sha256!==p.binding.policy_sha256||c.capture.issue.state!=='CLOSED')fail('ACCEPTANCE_READER_BINDING_INVALID');
      const request=parseRemoteBridgeRequestV2({title:c.capture.issue.title,body:c.capture.issue.body,author:c.capture.issue.author,repository:c.capture.repository,expectedAuthor:p.binding.author,expectedRepository:p.binding.repository,now,allowExpired:true});
      if(request.requestId!==e.request_id||request.operation.kind!==c.kind)fail('ACCEPTANCE_OPERATION_INVALID');
      if(c.kind==='HEALTH'){if(request.operation.kind!=='HEALTH'||request.operation.action!=='STATUS')fail('ACCEPTANCE_OPERATION_INVALID');}
      else if(request.operation.kind!=='FILE'||request.operation.action!=='READ'||request.operation.target!==p.paths.canary_path||Object.keys(request.operation.args).length!==0)fail('ACCEPTANCE_OPERATION_INVALID');
      if(original){const pin=original.operations[index]!;if(pin.operation_id!==e.request_id||pin.kind!==c.kind||pin.request_sha256!==sha(c.capture.issue.body)||now.getTime()<=timestamp(request.expiresAt).getTime())fail('ACCEPTANCE_REPLAY_IDENTITY_CHANGED');}
      return request;
    });
    const deadline=performance.now()+Math.min(p.budget.acceptance_ms,180000);let total=0;
    for(let index=0;index<input.cases.length;index++){
      if(performance.now()>=deadline)fail('ACCEPTANCE_DEADLINE');
      const c=input.cases[index]!,pin=original?.operations[index],e={...c.expected,...(pin?{receipt_sha256:pin.receipt_sha256,output_sha256:pin.output_sha256,selected_comment_id:pin.comment_id}:{})};
      const github=readRBridgeGitHubCarrier(c.capture,e);
      if(github.kind!=='CORE_RESULT'||github.status!=='PASS'||!github.receipt||github.output===undefined||github.receipt.phase!=='TERMINAL'||github.receipt.outcome!=='PASS')fail('ACCEPTANCE_GITHUB_NOT_PASS');
      const receiptSHA=innerHash(github.receipt),outputSHA=innerHash(github.output);
      const mcp=await readRBridgeMcpOutput(c.client,{...e.scope!,runtime_uid:p.binding.uid,intent_sha256:e.intent_sha256!,policy_sha256:p.binding.policy_sha256,receipt_sha256:receiptSHA,output_sha256:outputSHA,deadline_ms:Math.max(1,Math.floor(deadline-performance.now()))});
      if(mcp.status!=='RESULT'||innerHash(mcp.receipt)!==receiptSHA||innerHash(mcp.output)!==outputSHA||mcp.output_sha256!==outputSHA||!mcp.query_evidence?.length)fail('ACCEPTANCE_MCP_NOT_PASS');
      const value=github.output as Record<string,unknown>;
      if(c.kind==='FILE'&&(value.path!==p.paths.canary_path||typeof value.text!=='string'||!Buffer.from(value.text,'utf8').equals(canary)))fail('ACCEPTANCE_CANARY_CHANGED');
      if(c.kind==='HEALTH'&&(value.schema!=='COCWIN_REMOTE_BRIDGE_HEALTH_V2'||value.status!=='PASS'||value.releaseSha!==p.runtime.source_sha))fail('ACCEPTANCE_HEALTH_CHANGED');
      if(pin&&(pin.receipt_sha256!==receiptSHA||pin.output_sha256!==outputSHA||pin.comment_id!==github.evidence.selected_comment_id))fail('ACCEPTANCE_ORIGINAL_TRUTH_CHANGED');
      const row:InstallAcceptedOperation={operation_id:e.request_id,kind:c.kind,receipt_sha256:receiptSHA,output_sha256:outputSHA,comment_id:github.evidence.selected_comment_id,request_sha256:sha(c.capture.issue.body),input_json:Buffer.from(encodeInstallReport({kind:c.kind,capture:c.capture,expected:e,request:requests[index],canary_sha256:sha(canary)})).toString('utf8'),github_verdict_json:Buffer.from(encodeInstallReport(github)).toString('utf8'),mcp_verdict_json:Buffer.from(encodeInstallReport(mcp)).toString('utf8')};
      total+=Buffer.byteLength(row.input_json)+Buffer.byteLength(row.github_verdict_json)+Buffer.byteLength(row.mcp_verdict_json);if(total>67108864)fail('ACCEPTANCE_EVIDENCE_BYTE_LIMIT');report.operations.push(row);
    }
    if(performance.now()>=deadline)fail('ACCEPTANCE_DEADLINE');
    report.actual_mcp_readers=input.cases.every(c=>isInstalledMcpReadClient(c.client));report.status='PASS';
  }catch(error){report.status='FAIL';report.reason_codes=[error instanceof Error&&/^ACCEPTANCE_[A-Z_]+$/.test(error.message)?error.message:'ACCEPTANCE_INPUT_INVALID'];}
  report.sha256=installHash({...report,sha256:''});return report;
}
