/** Fixed final-material fixture entry; source paths and report labels grant no authority. */
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {qualifyRBridgeArtifactWithEvidence,validateArtifactManifest,validateArtifactIsolationHome} from '../installation/artifactQualification.js';
import {encodeInstallReport,parseRBridgeInstallProfile} from '../installation/types.js';
import {parseStrictJson} from '../installation/strictJson.js';

const error=()=>({schema:'RBRIDGE_INSTALL_ARTIFACT_ERROR_V1',status:'UNKNOWN' as const,
  scope:'UNQUALIFIED' as const,reason_codes:['ARTIFACT_INPUT_INVALID']});
export async function runArtifactQualification(input:unknown){
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))return error();
    const row=input as Record<string,unknown>;
    if(Object.keys(row).sort().join(',')!=='isolated_home,profile,runtime_manifest,schema,toolkit_manifest'
      ||row.schema!=='RBRIDGE_INSTALL_ARTIFACT_INPUT_V1'||typeof row.isolated_home!=='string')return error();
    const profile=parseRBridgeInstallProfile(row.profile),runtimeManifest=validateArtifactManifest(row.runtime_manifest),toolkitManifest=validateArtifactManifest(row.toolkit_manifest);
    validateArtifactIsolationHome(profile,row.isolated_home);
    return await qualifyRBridgeArtifactWithEvidence({profile,
      runtimeRoot:join(profile.paths.release_parent,profile.runtime.source_sha),
      toolkitRoot:join(profile.paths.release_parent,'toolkit-'+profile.toolkit.source_sha),
      manifestSHA256:runtimeManifest.sha256,runtimeManifest,toolkitManifest,isolatedHome:row.isolated_home});
  }catch{return error();}
}
async function main(){
  const chunks:Buffer[]=[];let size=0;const deadline=setTimeout(()=>{process.stdin.destroy();process.exitCode=2;},15000);
  try{
    if(process.argv.length!==2)throw new Error('ARTIFACT_INPUT_INVALID');
    const nonce=process.env.RBRIDGE_INSTALL_HELPER_NONCE;
    if(nonce!==undefined){
      if(!/^[0-9a-f]{64}$/.test(nonce))throw new Error('ARTIFACT_INPUT_INVALID');
      process.stderr.write(JSON.stringify({schema:'RBRIDGE_INSTALL_HELPER_READY_V1',pid:process.pid,nonce})+'\n');
    }
    for await(const bytes of process.stdin){
      const chunk=Buffer.from(bytes as Uint8Array);size+=chunk.length;
      if(size>67108864)throw new Error('ARTIFACT_INPUT_INVALID');chunks.push(chunk);
    }
    clearTimeout(deadline);
    const input=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    const result=await runArtifactQualification(input),status='report' in result?result.report.status:result.status;
    const output=encodeInstallReport(result);if(output.length>67108864)throw new Error('ARTIFACT_INPUT_INVALID');
    process.stdout.write(Buffer.from(output));process.stdout.write('\n');
    process.exitCode=status==='PASS'?0:status==='BLOCKED'?4:status==='FAIL'?5:2;
  }catch{process.stdout.write(Buffer.from(encodeInstallReport(error())));process.stdout.write('\n');process.exitCode=2;}
  finally{clearTimeout(deadline);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main();
