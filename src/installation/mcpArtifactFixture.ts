/** Fixed read-only SDK captures of the original isolated artifact operations.
 * The expected verdict is assembled from pinned operation preimages and actual
 * wire responses, never by invoking the result reader under qualification.
 */
import {createHash} from 'node:crypto';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {parseRBridgeDeploymentBinding,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {captureArtifactOperation} from './artifactEvidence.js';
import {parseRBridgeCarrierJson} from './carrierJson.js';
import {installHash} from './gateContext.js';
import type {McpReadClient,McpReaderScope} from './rbridge-installation-client.js';
import type {McpQueryEvidence} from './readerQualification.js';
import {encodeInstallReport} from './types.js';

const SOURCE='b5881fd8367b4249e82683f1f884f2392cb696d4';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail(reason='MCP_FIXTURE_INPUT_INVALID'):never{throw new Error(reason);}
function object(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))fail();return value as Record<string,unknown>;}
type Original=ReturnType<typeof captureArtifactOperation>;
export interface McpArtifactCaseInput{
  binding:RBridgeDeploymentBinding;source_sha:string;policy_sha256:string;
  originals:readonly Original[];clients:readonly McpReadClient[];deadline_ms:number;
}
interface ProducerCase{
  fixture_id:string;case_id:'C09';transport:'MCP';provenance:'SOURCE_PRODUCER';era:'legacy'|'modern';expected:McpReaderScope;
  expected_verdict_json:string;expected_verdict_sha256:string;expected_verdict_canonical_sha256:string;sdk_transcript_json:string;
}
export async function produceMcpArtifactCases(input:McpArtifactCaseInput){
  const binding=parseRBridgeDeploymentBinding(input.binding);
  if(input.source_sha!==SOURCE||!/^[0-9a-f]{64}$/.test(input.policy_sha256)||!Number.isSafeInteger(input.deadline_ms)
    ||input.deadline_ms<1||input.deadline_ms>180000||!Array.isArray(input.originals)||input.originals.length!==2
    ||!Array.isArray(input.clients)||input.clients.length!==2)fail();
  const before=Buffer.from(encodeInstallReport(input.originals)),deadline=performance.now()+input.deadline_ms,signal=AbortSignal.timeout(input.deadline_ms),cases:ProducerCase[]=[];
  const originals=input.originals.map((r:Original,index:number)=>{
    if(r.operationId!==(index===0?'artifact-health':'artifact-read')||!Array.isArray(r.pagesJSON))fail();
    const submission=object(parseRBridgeCarrierJson(Buffer.from(r.submissionJSON),131072)),context=object(parseRBridgeCarrierJson(Buffer.from(r.contextJSON),131072));
    if(submission.principalId!==binding.principalId||submission.targetInstanceId!==binding.targetInstanceId
      ||context.authenticatedSubject!=='uid:'+binding.runtimeUid||context.principalId!==binding.principalId)fail();
    const receipt=parseRBridgeExecutionReceipt(parseRBridgeCarrierJson(Buffer.from(r.receiptJSON),131072),
      {operationId:r.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId});
    const rebuilt=captureArtifactOperation({submission,context:context as unknown as RBridgeTransportContextV1,receipt,
      pages:r.pagesJSON.map(raw=>parseRBridgeCarrierJson(Buffer.from(raw),131072)),output:Buffer.from(r.resultBase64,'base64'),policy_sha256:input.policy_sha256});
    if(!Buffer.from(encodeInstallReport(rebuilt)).equals(encodeInstallReport(r)))fail('MCP_FIXTURE_ORIGINAL_CHANGED');
    return {record:rebuilt,receipt};
  });
  for(const [index,client] of input.clients.entries()){
    const era=index===0?'legacy' as const:'modern' as const;
    if(client.protocol_era!==era||client.sdk_package_version!=='2.3.0'
      ||(era==='modern'?client.negotiated_protocol_version!=='2026-07-28':!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(client.negotiated_protocol_version)))fail('MCP_FIXTURE_SDK_INVALID');
    const {record,receipt}=originals[index]!,queryEvidence:McpQueryEvidence[]=[],responses:unknown[]=[];
    const expected:McpReaderScope={operationId:record.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,
      runtime_uid:binding.runtimeUid,intent_sha256:receipt.intentSha256,policy_sha256:input.policy_sha256,
      receipt_sha256:record.receiptSHA256,output_sha256:record.resultSHA256,deadline_ms:input.deadline_ms};
    async function query(name:Parameters<McpReadClient['callTool']>[0]['name'],args:Record<string,unknown>,expectedRow:unknown){
      const remaining=deadline-performance.now();if(signal.aborted||remaining<=0)fail('MCP_FIXTURE_DEADLINE');let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const frame=object(await Promise.race([client.callTool({name,arguments:args},{signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MCP_FIXTURE_DEADLINE')),remaining);})]));
        if(Object.keys(frame).some(k=>!['content','structuredContent','isError','_meta'].includes(k))||!Object.hasOwn(frame,'structuredContent')
          ||(Object.hasOwn(frame,'isError')&&frame.isError!==false)||!Array.isArray(frame.content)||frame.content.length!==1)fail('MCP_FIXTURE_FRAME_INVALID');
        if(Object.hasOwn(frame,'_meta')){
          const meta=object(frame._meta),info=object(meta['io.modelcontextprotocol/serverInfo']);
          if(Object.keys(meta).length!==1||Object.keys(info).sort().join(',')!=='name,version'||info.name!=='rbridge'||info.version!=='0.1.0-dev')fail('MCP_FIXTURE_FRAME_INVALID');
        }
        const content=object(frame.content[0]);if(Object.keys(content).sort().join(',')!=='text,type'||content.type!=='text'||typeof content.text!=='string')fail('MCP_FIXTURE_FRAME_INVALID');
        const value=parseRBridgeCarrierJson(Buffer.from(content.text),131072);
        if(installHash(value)!==installHash(expectedRow)||installHash(frame.structuredContent)!==installHash(expectedRow))fail('MCP_FIXTURE_RESPONSE_CHANGED');
        queryEvidence.push({name,arguments_json:JSON.stringify(args),response_json:content.text,response_sha256:sha(content.text)});
        responses.push({name,arguments:structuredClone(args),response:structuredClone(frame)});
        if(encodeInstallReport({queryEvidence,responses}).length>67108864)fail('MCP_FIXTURE_EVIDENCE_LIMIT');
      }finally{clearTimeout(timer);}
    }
    const capability={schema:'RBRIDGE_MCP_CAPABILITIES_V1',mode:'SAFE',principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,
      supportedKinds:['HEALTH','FILE','PROCESS','CHUNK'],enabledActions:[...RBRIDGE_ENABLED_ACTIONS],policySha256:input.policy_sha256,
      executionAvailable:true,executionStatus:'CORE_CONNECTED'};
    const status={schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:'rbridge_status',result:{status:'RECEIPT',receipt}};
    await query('rbridge_capabilities',{},capability);await query('rbridge_status',{operationId:record.operationId},status);
    for(const raw of record.pagesJSON){
      const page=object(parseRBridgeCarrierJson(Buffer.from(raw),131072));
      await query('rbridge_result',{operationId:record.operationId,cursor:page.cursor,maxBytes:32768},
        {schema:'RBRIDGE_MCP_CORE_QUERY_RESULT_V1',tool:'rbridge_result',result:page});
    }
    await query('rbridge_status',{operationId:record.operationId},status);await query('rbridge_capabilities',{},capability);
    const verdict={scope:'REFERENCE_MCP_READ',query_evidence:queryEvidence,status:'RESULT',reason_codes:[],receipt,
      output:parseRBridgeCarrierJson(Buffer.from(record.resultJSON),8388608),output_sha256:record.resultSHA256,raw_output_base64:record.resultBase64,
      response_sha256:queryEvidence.map(row=>row.response_sha256),sdk_package_version:client.sdk_package_version,
      negotiated_protocol_version:client.negotiated_protocol_version,protocol_era:client.protocol_era};
    const raw=JSON.stringify(verdict),transcript=JSON.stringify({sdk_package_version:client.sdk_package_version,
      negotiated_protocol_version:client.negotiated_protocol_version,protocol_era:client.protocol_era,responses});
    cases.push({fixture_id:'mcp-producer-'+era,case_id:'C09',transport:'MCP',provenance:'SOURCE_PRODUCER',era,expected,
      expected_verdict_json:raw,expected_verdict_sha256:sha(raw),expected_verdict_canonical_sha256:installHash(verdict),sdk_transcript_json:transcript});
  }
  if(!before.equals(encodeInstallReport(input.originals)))fail('MCP_FIXTURE_ORIGINAL_CHANGED');
  const report={schema:'RBRIDGE_ISOLATED_MCP_CASES_V1',scope:'ISOLATED_MCP_SOURCE_DATA_ONLY',producer_source_sha:SOURCE,
    binding_sha256:installHash(binding),original_receipts:originals.map(({record})=>({operation_id:record.operationId,
      receipt_json:record.receiptJSON,receipt_sha256:record.receiptSHA256,output_sha256:record.resultSHA256})),originals_unchanged:true,cases};
  if(encodeInstallReport(report).length>67108864)fail('MCP_FIXTURE_EVIDENCE_LIMIT');return report;
}
