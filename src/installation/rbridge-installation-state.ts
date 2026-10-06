import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openReadonlySnapshot,type ReadonlySnapshot} from './readonlySnapshot.js';
import {encodeInstallReport,parseRBridgeInstallProfile,validateInstallContract,type SnapshotToken,type InstallStatus} from './types.js';

export interface StateHelperReport{schema:'RBRIDGE_INSTALLATION_STATE_RESULT_V1';scope:'READONLY_SNAPSHOT_BYTES_ONLY';status:InstallStatus;reason_codes:readonly string[];snapshot_sha256:string;token_sha256:string;entries:number;bytes:number;coreObserved:'ABSENT'|'PRESENT'|'NOT_PERFORMED';}
export async function runInstallationState(input:unknown):Promise<StateHelperReport>{
  const report:StateHelperReport={schema:'RBRIDGE_INSTALLATION_STATE_RESULT_V1',scope:'READONLY_SNAPSHOT_BYTES_ONLY',status:'UNKNOWN',reason_codes:[],snapshot_sha256:'',token_sha256:'',entries:0,bytes:0,coreObserved:'NOT_PERFORMED'};let snapshot:ReadonlySnapshot|undefined;
  try{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='profile,schema,token')throw new Error('STATE_INPUT_INVALID');
    const raw=input as Record<string,unknown>;if(raw.schema!=='RBRIDGE_INSTALLATION_STATE_INPUT_V1')throw new Error('STATE_INPUT_INVALID');
    const profile=parseRBridgeInstallProfile(raw.profile);validateInstallContract(raw.token,'SnapshotToken');const token=raw.token as SnapshotToken;
    snapshot=await openReadonlySnapshot(profile,token);await snapshot.verify();
    report.snapshot_sha256=snapshot.treeSHA256;report.token_sha256=createHash('sha256').update(encodeInstallReport(token)).digest('hex');report.entries=snapshot.entries.length;report.bytes=snapshot.bytes;report.coreObserved=snapshot.entries.some(e=>e.path==='execution-v2')?'PRESENT':'ABSENT';report.reason_codes=snapshot.reasonCodes;report.status=snapshot.reasonCodes.length?'BLOCKED':'PASS';
  }catch(error){report.reason_codes=[error instanceof Error&&/^STATE_[A-Z_]+$/.test(error.message)?error.message:'STATE_VALIDATION_UNAVAILABLE'];}
  finally{await snapshot?.close();}
  return report;
}
async function main(){
  const chunks:Buffer[]=[];let count=0;const deadline=setTimeout(()=>{process.stdin.destroy();process.exitCode=2;},15000);
  try{
    for await(const raw of process.stdin){const chunk=Buffer.from(raw as Uint8Array);count+=chunk.length;if(count>2097152)throw new Error('STATE_INPUT_LIMIT');chunks.push(chunk);}
    clearTimeout(deadline);const report=await runInstallationState(JSON.parse(Buffer.concat(chunks).toString('utf8')));process.stdout.write(Buffer.from(encodeInstallReport(report)));process.stdout.write('\n');process.exitCode=report.status==='PASS'?0:report.status==='BLOCKED'?4:2;
  }catch{process.stdout.write('{"schema":"RBRIDGE_INSTALLATION_STATE_RESULT_V1","status":"UNKNOWN","reason_codes":["STATE_INPUT_INVALID"]}\n');process.exitCode=2;}
  finally{clearTimeout(deadline);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main();
