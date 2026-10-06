import {createHash} from 'node:crypto';
import type {ReadonlySnapshot} from './readonlySnapshot.js';
import {encodeInstallReport,type InstallProfile,type SnapshotToken,type IssueEvidence,type Gate,type GateReport,type InstallStatus,type Check} from './types.js';
export interface LookupCapture{scope:'FIXTURE_AUTHORITY_ONLY'|'QUALIFIED_GITHUB_READ';status:InstallStatus;viewer:string;repository:string;profile_sha256:string;snapshot_sha256:string;capture_sha256:string;}
export interface GateContext{profile:InstallProfile;snapshot:ReadonlySnapshot;token:SnapshotToken;issues:readonly IssueEvidence[];lookup:LookupCapture;}
export const installHash=(value:unknown)=>createHash('sha256').update(encodeInstallReport(value)).digest('hex');
export function gateReport(context:GateContext,gate:Gate,status:InstallStatus,reasons:readonly string[],checks:readonly Check[]=[],evidence:unknown={}):GateReport{
  return {gate,status,snapshot_sha256:installHash(context.token),evidence_sha256:installHash(evidence),reason_codes:[...new Set(reasons)].sort(),checks};
}
