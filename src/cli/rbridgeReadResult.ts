import {pathToFileURL} from 'node:url';
import {parseRBridgeCarrierJson} from '../installation/carrierJson.js';
import {readRBridgeGitHubCarrier} from '../installation/githubCarrierReader.js';
import {createInstalledReaderRunner,createReferenceReaderRunner,qualifyRBridgeReaders,readRBridgeMcpOutput,readerFixtureInputJson,type ReaderFixture,type ReaderFixtureSet,type ReaderRegistry} from '../installation/readerQualification.js';
import {createInstalledMcpReadClient,createInstalledMcpFixtureSession,qualifyInstalledReaderRuntime,type InstalledReaderAuthority,type McpReadClient,type McpReaderScope} from '../installation/rbridge-installation-client.js';
import {MCP_NEGATIVE_VARIANTS,type McpNegativeVariant} from '../installation/mcpNegativeCases.js';
import {parseRBridgeInstallProfile,type ArtifactManifest} from '../installation/types.js';
import type {CarrierCapture,ReaderExpectation} from '../installation/rbridge-installation-reader.js';
import {runArchivedReaderFixture,runArchivedCoreProducer,runArchivedMcpProducer} from '../installation/archivedReaderFixture.js';
import {acceptRBridgeInstallation,type InstallAcceptanceCase,type InstallAcceptanceReport} from './rbridgeInstallationAccept.js';
function fail():never{throw new Error('READER_CLI_INPUT_INVALID');}
function object(v:unknown){if(!v||typeof v!=='object'||Array.isArray(v))fail();return v as Record<string,unknown>;}
function fields(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]){if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail();}
export function createTranscriptMcpClient(value:unknown):McpReadClient{
  const row=object(value);fields(row,['sdk_package_version','negotiated_protocol_version','protocol_era','responses']);if(!Array.isArray(row.responses)||row.responses.length>1024||typeof row.sdk_package_version!=='string'||typeof row.negotiated_protocol_version!=='string'||!['legacy','modern'].includes(String(row.protocol_era)))fail();
  const replies=structuredClone(row.responses) as unknown[];let at=0;
  return {scope:'FIXTURE_AUTHORITY_ONLY',sdk_package_version:row.sdk_package_version,negotiated_protocol_version:row.negotiated_protocol_version,protocol_era:row.protocol_era as 'legacy'|'modern',async callTool(input){const reply=object(replies[at++]);fields(reply,['name','arguments','response']);if(reply.name!==input.name||JSON.stringify(reply.arguments)!==JSON.stringify(input.arguments))fail();return structuredClone(reply.response);}};
}
export async function runRBridgeReadResult(input:unknown){
  const closing:Array<()=>Promise<void>>=[];
  try{
    const row=object(input);if(row.schema!=='RBRIDGE_READER_INPUT_V1')fail();
    if(row.operation==='GITHUB_PARSE'){fields(row,['schema','operation','capture','expected']);return readRBridgeGitHubCarrier(row.capture as CarrierCapture,row.expected as ReaderExpectation);}
    if(row.operation==='MCP_TRANSCRIPT'){fields(row,['schema','operation','transcript','expected']);return await readRBridgeMcpOutput(createTranscriptMcpClient(row.transcript),row.expected as McpReaderScope);}
    if(!['QUALIFY_REFERENCE','QUALIFY_INSTALLED','QUALIFY_INSTALLED_ARCHIVED_ARTIFACT','PRODUCE_CORE_ARCHIVED_ARTIFACT','PRODUCE_MCP_ARCHIVED_ARTIFACT','MCP_READ_INSTALLED','ACCEPT_READ_INSTALLED'].includes(String(row.operation)))fail();
    let authority:InstalledReaderAuthority|undefined;
    if(row.operation!=='QUALIFY_REFERENCE'){const profile=parseRBridgeInstallProfile(row.profile);authority=await qualifyInstalledReaderRuntime(profile,row.toolkit_manifest as ArtifactManifest);}
    if(row.operation==='PRODUCE_CORE_ARCHIVED_ARTIFACT'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','isolated_home','artifact_fixture','context_sha256']);
      if(!authority||typeof row.isolated_home!=='string'||typeof row.context_sha256!=='string')fail();
      return await runArchivedCoreProducer(authority,row.runtime_manifest as ArtifactManifest,row.isolated_home,row.artifact_fixture,row.context_sha256);
    }
    if(row.operation==='PRODUCE_MCP_ARCHIVED_ARTIFACT'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','isolated_home','artifact_fixture']);
      if(!authority||typeof row.isolated_home!=='string')fail();
      return await runArchivedMcpProducer(authority,row.runtime_manifest as ArtifactManifest,row.isolated_home,row.artifact_fixture);
    }
    if(row.operation==='QUALIFY_INSTALLED_ARCHIVED_ARTIFACT'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','registry','fixtures','isolated_home','artifact_fixture']);
      if(!authority||typeof row.isolated_home!=='string')fail();
      return await runArchivedReaderFixture(authority,row.runtime_manifest as ArtifactManifest,row.isolated_home,row.artifact_fixture,row.registry,row.fixtures);
    }
    if(row.operation==='MCP_READ_INSTALLED'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','era','expected'],['isolated_root']);if(!authority||!['legacy','modern'].includes(String(row.era))||(row.isolated_root!==undefined&&typeof row.isolated_root!=='string'))fail();
      const client=await createInstalledMcpReadClient(authority,row.runtime_manifest as ArtifactManifest,row.era as 'legacy'|'modern',row.isolated_root);closing.push(()=>client.close());return await readRBridgeMcpOutput(client,row.expected as McpReaderScope);
    }
    if(row.operation==='ACCEPT_READ_INSTALLED'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','stage','captured_at','canary_base64','cases'],['original']);
      if(!authority||!['ORIGINAL','REPLAY'].includes(String(row.stage))||typeof row.captured_at!=='string'||typeof row.canary_base64!=='string'||!Array.isArray(row.cases)||row.cases.length!==2)fail();
      const runner=await createInstalledReaderRunner(authority),cases:InstallAcceptanceCase[]=[];
      for(const raw of row.cases){
        const c=object(raw);fields(c,['kind','capture','expected','era']);if(!['HEALTH','FILE'].includes(String(c.kind))||!['legacy','modern'].includes(String(c.era)))fail();
        const client=await createInstalledMcpReadClient(authority,row.runtime_manifest as ArtifactManifest,c.era as 'legacy'|'modern');closing.push(()=>client.close());
        cases.push({kind:c.kind as 'HEALTH'|'FILE',capture:c.capture as CarrierCapture,expected:c.expected as ReaderExpectation,client});
      }
      const report=await acceptRBridgeInstallation({profile:authority.profile,stage:row.stage as 'ORIGINAL'|'REPLAY',captured_at:row.captured_at,canary_base64:row.canary_base64,cases,...(row.original!==undefined?{original:row.original as InstallAcceptanceReport}:{})});
      const invocations=[];
      if(report.status==='PASS')for(let index=0;index<cases.length;index++){
        const c=cases[index]!,operation=report.operations[index]!;
        for(const transport of ['GITHUB','MCP'] as const){
          const registrations=authority.profile.readers.filter(r=>r.transport===transport);if(!registrations.length)fail();
          for(const registration of registrations){
            const metadata={fixture_id:'installation-'+row.stage+'-'+operation.operation_id,case_id:transport==='GITHUB'?'C02' as const:'C09' as const,provenance:'SOURCE_PRODUCER' as const,expected_verdict_sha256:'0'.repeat(64)};
            const fixture:ReaderFixture=transport==='GITHUB'?{...metadata,transport,capture:c.capture,expected:{...c.expected,receipt_sha256:operation.receipt_sha256,output_sha256:operation.output_sha256,selected_comment_id:operation.comment_id}}:{...metadata,transport,client:c.client,expected:{...c.expected.scope!,runtime_uid:authority.profile.binding.uid,intent_sha256:c.expected.intent_sha256!,policy_sha256:authority.profile.binding.policy_sha256,receipt_sha256:operation.receipt_sha256,output_sha256:operation.output_sha256,deadline_ms:Math.min(authority.profile.budget.lookup_ms,180000)}};
            const invocation=await runner.invoke(registration,fixture);
            invocations.push({reader_id:registration.reader_id,operation_id:operation.operation_id,transport,input_json:readerFixtureInputJson(fixture),verdict_json:JSON.stringify(invocation.verdict),invocation});
          }
        }
      }
      return {schema:'RBRIDGE_INSTALL_NAMED_READERS_V1',report,invocations};
    }
    fields(row,['schema','operation','registry','fixtures'],row.operation==='QUALIFY_INSTALLED'?['profile','toolkit_manifest','runtime_manifest']:[]);
    const cases=object(row.fixtures).cases;if(!Array.isArray(cases)||cases.length>512)fail();const fixtures:ReaderFixtureSet={cases:[]};
    const built:ReaderFixture[]=[],liveClients=new Map<string,Awaited<ReturnType<typeof createInstalledMcpReadClient>>>(),fixtureSessions=new Map<string,Awaited<ReturnType<typeof createInstalledMcpFixtureSession>>>();
    for(const value of cases){const f=object(value);if(f.transport==='GITHUB'){fields(f,['fixture_id','case_id','provenance','expected_verdict_sha256','transport','capture','expected'],['replayed_at']);built.push(f as unknown as ReaderFixture);}
      else if(f.transport==='MCP'){
        fields(f,['fixture_id','case_id','provenance','expected_verdict_sha256','transport','expected'],authority?['era','isolated_root','fixture_variant']:['transcript']);let client:McpReadClient;
        if(authority){
          if(!['legacy','modern'].includes(String(f.era))||(f.isolated_root!==undefined&&typeof f.isolated_root!=='string'))fail();
          const era=f.era as 'legacy'|'modern',key=era+'|'+String(f.isolated_root??'LIVE');
          if(f.fixture_variant!==undefined){
            if(f.provenance!=='SOURCE_PRODUCER'||typeof f.isolated_root!=='string'||!MCP_NEGATIVE_VARIANTS.includes(f.fixture_variant as McpNegativeVariant))fail();
            let session=fixtureSessions.get(key);if(!session){session=await createInstalledMcpFixtureSession(authority,row.runtime_manifest as ArtifactManifest,era,f.isolated_root);fixtureSessions.set(key,session);closing.push(()=>session!.close());}
            client=session.forCase(f.fixture_variant as McpNegativeVariant,f.expected as McpReaderScope);
          }else{
            let live=liveClients.get(key);if(!live){live=await createInstalledMcpReadClient(authority,row.runtime_manifest as ArtifactManifest,era,f.isolated_root);liveClients.set(key,live);closing.push(()=>live!.close());}client=live;
          }
        }
        else client=createTranscriptMcpClient(f.transcript);
        built.push({fixture_id:f.fixture_id as string,case_id:f.case_id as 'C09',provenance:f.provenance as 'SOURCE_PRODUCER',expected_verdict_sha256:f.expected_verdict_sha256 as string,transport:'MCP',expected:f.expected as McpReaderScope,client});
      }else fail();
    }
    fixtures.cases=built;const runner=authority?await createInstalledReaderRunner(authority):createReferenceReaderRunner();return await qualifyRBridgeReaders(row.registry as unknown as ReaderRegistry,fixtures,runner);
  }catch(error){return {schema:'RBRIDGE_READER_CLI_ERROR_V1',status:'UNKNOWN',reason_codes:[error instanceof Error&&/^READER_[A-Z_]+$/.test(error.message)?error.message:'READER_CLI_INPUT_INVALID']};}
  finally{for(const close of closing.reverse())await close();}
}
async function main(){
  const chunks:Buffer[]=[];let size=0;const deadline=setTimeout(()=>{process.stdin.destroy();process.exitCode=2;},15000);
  try{
    if(process.argv.length!==2)fail();
    const nonce=process.env.RBRIDGE_INSTALL_HELPER_NONCE;
    if(nonce!==undefined){if(!/^[0-9a-f]{64}$/.test(nonce))fail();process.stderr.write(JSON.stringify({schema:'RBRIDGE_INSTALL_HELPER_READY_V1',pid:process.pid,nonce})+'\n');}
    for await(const raw of process.stdin){const bytes=Buffer.from(raw as Uint8Array);size+=bytes.length;if(size>67108864)fail();chunks.push(bytes);}clearTimeout(deadline);
    const result=await runRBridgeReadResult(parseRBridgeCarrierJson(Buffer.concat(chunks),67108864));const bytes=Buffer.from(JSON.stringify(result));if(bytes.length>67108864)fail();process.stdout.write(bytes);process.stdout.write('\n');
    process.exitCode='actualAcceptance'in result?result.actualAcceptance==='PASS'?0:result.actualAcceptance==='FAIL'?5:2:'schema'in result&&['RBRIDGE_ISOLATED_CORE_CASES_V1','RBRIDGE_ISOLATED_MCP_CASES_V1'].includes(result.schema)?0:'status'in result&&['INVALID','FAIL'].includes(result.status)?5:2;
  }catch{process.stdout.write('{"schema":"RBRIDGE_READER_CLI_ERROR_V1","status":"UNKNOWN","reason_codes":["READER_CLI_INPUT_INVALID"]}\n');process.exitCode=2;}finally{clearTimeout(deadline);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main();
