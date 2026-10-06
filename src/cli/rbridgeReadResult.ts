import {pathToFileURL} from 'node:url';
import {parseRBridgeCarrierJson} from '../installation/carrierJson.js';
import {readRBridgeGitHubCarrier} from '../installation/githubCarrierReader.js';
import {createInstalledReaderRunner,createReferenceReaderRunner,qualifyRBridgeReaders,readRBridgeMcpOutput,type ReaderFixture,type ReaderFixtureSet,type ReaderRegistry} from '../installation/readerQualification.js';
import {createInstalledMcpReadClient,qualifyInstalledReaderRuntime,type InstalledReaderAuthority,type McpReadClient,type McpReaderScope} from '../installation/rbridge-installation-client.js';
import {parseRBridgeInstallProfile,type ArtifactManifest} from '../installation/types.js';
import type {CarrierCapture,ReaderExpectation} from '../installation/rbridge-installation-reader.js';
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
    if(!['QUALIFY_REFERENCE','QUALIFY_INSTALLED','MCP_READ_INSTALLED'].includes(String(row.operation)))fail();
    let authority:InstalledReaderAuthority|undefined;
    if(row.operation!=='QUALIFY_REFERENCE'){const profile=parseRBridgeInstallProfile(row.profile);authority=await qualifyInstalledReaderRuntime(profile,row.toolkit_manifest as ArtifactManifest);}
    if(row.operation==='MCP_READ_INSTALLED'){
      fields(row,['schema','operation','profile','toolkit_manifest','runtime_manifest','era','expected'],['isolated_root']);if(!authority||!['legacy','modern'].includes(String(row.era))||(row.isolated_root!==undefined&&typeof row.isolated_root!=='string'))fail();
      const client=await createInstalledMcpReadClient(authority,row.runtime_manifest as ArtifactManifest,row.era as 'legacy'|'modern',row.isolated_root);closing.push(()=>client.close());return await readRBridgeMcpOutput(client,row.expected as McpReaderScope);
    }
    fields(row,['schema','operation','registry','fixtures'],row.operation==='QUALIFY_INSTALLED'?['profile','toolkit_manifest','runtime_manifest']:[]);
    const cases=object(row.fixtures).cases;if(!Array.isArray(cases)||cases.length>512)fail();const fixtures:ReaderFixtureSet={cases:[]};
    const built:ReaderFixture[]=[];
    for(const value of cases){const f=object(value);if(f.transport==='GITHUB'){fields(f,['fixture_id','case_id','provenance','expected_verdict_sha256','transport','capture','expected'],['replayed_at']);built.push(f as unknown as ReaderFixture);}
      else if(f.transport==='MCP'){
        fields(f,['fixture_id','case_id','provenance','expected_verdict_sha256','transport','expected'],authority?['era','isolated_root']:['transcript']);let client:McpReadClient;
        if(authority){if(!['legacy','modern'].includes(String(f.era))||(f.isolated_root!==undefined&&typeof f.isolated_root!=='string'))fail();const live=await createInstalledMcpReadClient(authority,row.runtime_manifest as ArtifactManifest,f.era as 'legacy'|'modern',f.isolated_root);client=live;closing.push(()=>live.close());}
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
    if(process.argv.length!==2)fail();for await(const raw of process.stdin){const bytes=Buffer.from(raw as Uint8Array);size+=bytes.length;if(size>67108864)fail();chunks.push(bytes);}clearTimeout(deadline);
    const result=await runRBridgeReadResult(parseRBridgeCarrierJson(Buffer.concat(chunks),67108864));const bytes=Buffer.from(JSON.stringify(result));if(bytes.length>67108864)fail();process.stdout.write(bytes);process.stdout.write('\n');
    process.exitCode='actualAcceptance'in result?result.actualAcceptance==='PASS'?0:result.actualAcceptance==='FAIL'?5:2:'status'in result&&['INVALID','FAIL'].includes(result.status)?5:2;
  }catch{process.stdout.write('{"schema":"RBRIDGE_READER_CLI_ERROR_V1","status":"UNKNOWN","reason_codes":["READER_CLI_INPUT_INVALID"]}\n');process.exitCode=2;}finally{clearTimeout(deadline);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main();
