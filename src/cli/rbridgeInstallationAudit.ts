import {pathToFileURL} from 'node:url';
import {openReadonlySnapshot,type ReadonlySnapshot} from '../installation/readonlySnapshot.js';
import {auditFirstInstallCore,collectFirstInstallGates} from '../installation/firstInstallGate.js';
import {collectLegacyIssueNumbers} from '../installation/legacyGate.js';
import {collectProcessProbeTargets} from '../installation/processGate.js';
import {parseStrictJson} from '../installation/strictJson.js';
import {encodeInstallReport,parseRBridgeInstallProfile,validateInstallContract,type IssueEvidence,type ProcessObservation,type SnapshotToken} from '../installation/types.js';
import type {LookupCapture} from '../installation/gateContext.js';
import {installHash} from '../installation/gateContext.js';

export const INSTALL_AUDIT_INPUT_BYTES=67108864;
export async function runInstallationDiscovery(input:unknown){
  let snapshot:ReadonlySnapshot|undefined;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('AUDIT_INPUT_INVALID');
    const raw=input as Record<string,unknown>;
    validateInstallContract(raw,'DiscoveryInput');
    if(Object.keys(raw).sort().join(',')!=='profile,schema,token'||raw.schema!=='RBRIDGE_INSTALL_DISCOVERY_INPUT_V1')throw new Error('AUDIT_INPUT_INVALID');
    const profile=parseRBridgeInstallProfile(raw.profile);validateInstallContract(raw.token,'SnapshotToken');
    const token=raw.token as SnapshotToken;snapshot=await openReadonlySnapshot(profile,token);
    const context={profile,snapshot,token,issues:[],lookup:{scope:'QUALIFIED_GITHUB_READ' as const,status:'UNKNOWN' as const,viewer:'',repository:'',profile_sha256:installHash(profile),snapshot_sha256:installHash(token),capture_sha256:installHash([])}};
    const core=await auditFirstInstallCore(context);if(core.status!=='PASS')throw new Error('AUDIT_CORE_ABSENCE_REQUIRED');
    const issue_numbers=await collectLegacyIssueNumbers(context),process_targets=await collectProcessProbeTargets(context);await snapshot.verify();
    return {schema:'RBRIDGE_INSTALL_DISCOVERY_RESULT_V1',scope:'READONLY_PROBE_TARGETS_ONLY',status:'PASS' as const,reason_codes:[],profile_sha256:installHash(profile),snapshot_sha256:installHash(token),core_absence_sha256:core.evidence_sha256,issue_numbers,process_targets};
  }catch(error){
    return {schema:'RBRIDGE_INSTALL_AUDIT_ERROR_V1',status:'UNKNOWN' as const,reason_codes:[error instanceof Error&&/^(?:STATE|AUDIT|PROCESS|LEGACY)_[A-Z_]+$/.test(error.message)?error.message:'AUDIT_INPUT_INVALID']};
  }finally{await snapshot?.close();}
}
export async function runInstallationAudit(input:unknown){
  let snapshot:ReadonlySnapshot|undefined;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('AUDIT_INPUT_INVALID');
    const raw=input as Record<string,unknown>;
    validateInstallContract(raw,'AuditInput');
    if(Object.keys(raw).sort().join(',')!=='issues,lookup,observations,profile,schema,token'||raw.schema!=='RBRIDGE_INSTALL_AUDIT_INPUT_V1')throw new Error('AUDIT_INPUT_INVALID');
    const profile=parseRBridgeInstallProfile(raw.profile);validateInstallContract(raw.token,'SnapshotToken');
    if(!Array.isArray(raw.issues)||raw.issues.length>profile.budget.state_entries||!Array.isArray(raw.observations)||raw.observations.length>profile.budget.state_entries||!raw.lookup||typeof raw.lookup!=='object'||Array.isArray(raw.lookup))throw new Error('AUDIT_INPUT_INVALID');
    const lookup=raw.lookup as Record<string,unknown>;
    if(Object.keys(lookup).sort().join(',')!=='capture_sha256,profile_sha256,repository,scope,snapshot_sha256,status,viewer'||lookup.scope!=='QUALIFIED_GITHUB_READ'||lookup.status!=='PASS'||['capture_sha256','profile_sha256','snapshot_sha256'].some(k=>typeof lookup[k]!=='string'||!/^[0-9a-f]{64}$/.test(lookup[k] as string))||typeof lookup.viewer!=='string'||typeof lookup.repository!=='string')throw new Error('AUDIT_INPUT_INVALID');
    for(const observation of raw.observations)validateInstallContract(observation,'ProcessObservation');
    const token=raw.token as SnapshotToken;snapshot=await openReadonlySnapshot(profile,token);
    return await collectFirstInstallGates({profile,snapshot,token,issues:raw.issues as IssueEvidence[],lookup:lookup as unknown as LookupCapture},raw.observations as ProcessObservation[]);
  }catch(error){
    return {schema:'RBRIDGE_INSTALL_AUDIT_ERROR_V1',status:'UNKNOWN' as const,reason_codes:[error instanceof Error&&/^STATE_[A-Z_]+$/.test(error.message)?error.message:'AUDIT_INPUT_INVALID']};
  }finally{await snapshot?.close();}
}
async function main(){
  const chunks:Buffer[]=[];let size=0;const deadline=setTimeout(()=>{process.stdin.destroy();process.exitCode=2;},15000);
  try{
    if(process.argv.length!==2)throw new Error('AUDIT_INPUT_INVALID');
    const nonce=process.env.RBRIDGE_INSTALL_HELPER_NONCE;
    if(nonce!==undefined){if(!/^[0-9a-f]{64}$/.test(nonce))throw new Error('AUDIT_INPUT_INVALID');process.stderr.write(JSON.stringify({schema:'RBRIDGE_INSTALL_HELPER_READY_V1',pid:process.pid,nonce})+'\n');}
    for await(const bytes of process.stdin){const chunk=Buffer.from(bytes as Uint8Array);size+=chunk.length;if(size>INSTALL_AUDIT_INPUT_BYTES)throw new Error('AUDIT_INPUT_INVALID');chunks.push(chunk);}
    clearTimeout(deadline);const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));const input=parseStrictJson(raw);
    const result=input&&typeof input==='object'&&!Array.isArray(input)&&(input as Record<string,unknown>).schema==='RBRIDGE_INSTALL_DISCOVERY_INPUT_V1'?await runInstallationDiscovery(input):await runInstallationAudit(input);
    process.stdout.write(Buffer.from(encodeInstallReport(result)));process.stdout.write('\n');process.exitCode=result.status==='PASS'?0:result.status==='BLOCKED'?4:result.status==='FAIL'?5:2;
  }catch{process.stdout.write('{"schema":"RBRIDGE_INSTALL_AUDIT_ERROR_V1","status":"UNKNOWN","reason_codes":["AUDIT_INPUT_INVALID"]}\n');process.exitCode=2;}
  finally{clearTimeout(deadline);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main();
