import {auditLegacyGate} from './legacyGate.js';
import {auditFlowPilotGate} from './flowPilotGate.js';
import {auditProcessGate} from './processGate.js';
import {auditTransferGate} from './transferGate.js';
import {gateReport,installHash,type GateContext} from './gateContext.js';
import {validateInstallContract,type Gate,type GateBundle,type GateReport,type ProcessObservation,type SnapshotToken,type InstallStatus} from './types.js';

const GATES:readonly Gate[]=['LEGACY','FLOWPILOT','PROCESS','TRANSFERS','CORE'];
async function matching(context:GateContext){
  validateInstallContract(context.token,'SnapshotToken');await context.snapshot.verify();
  if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes)throw new Error('BUNDLE_SNAPSHOT_MISMATCH');
}
export async function auditFirstInstallCore(context:GateContext):Promise<GateReport>{
  try{
    await matching(context);
    if(context.snapshot.entries.some(e=>e.path==='execution-v2'||e.path.startsWith('execution-v2/')))return gateReport(context,'CORE','BLOCKED',['CORE_UNEXPECTED_EXISTING_STATE']);
    if(context.snapshot.reasonCodes.length)return gateReport(context,'CORE','BLOCKED',context.snapshot.reasonCodes);
    await matching(context);
    return gateReport(context,'CORE','PASS',[],[{name:'descriptor-inventory-core-absence',status:'PASS'}],{observed:'ABSENT',tree_sha256:context.snapshot.treeSHA256});
  }catch{return gateReport(context,'CORE','UNKNOWN',['CORE_ABSENCE_UNPROVEN']);}
}
export function validateFirstInstallGateBundle(reports:readonly GateReport[],token:SnapshotToken):GateBundle{
  validateInstallContract(token,'SnapshotToken');
  const reasons=new Set<string>(),valid:GateReport[]=[],seen=new Set<Gate>();let status:InstallStatus='PASS';
  for(const report of reports){
    try{validateInstallContract(report,'GateReport');}catch{reasons.add('BUNDLE_REPORT_INVALID');status='UNKNOWN';continue;}
    if(seen.has(report.gate)){reasons.add('BUNDLE_DUPLICATE_GATE');status='UNKNOWN';continue;}
    seen.add(report.gate);valid.push(report);
    if(report.snapshot_sha256!==installHash(token)){reasons.add('BUNDLE_SNAPSHOT_MISMATCH');status='UNKNOWN';}
    if(report.status==='PASS'&&report.reason_codes.length){reasons.add('BUNDLE_PASS_WITH_FAILURE_REASON');status='UNKNOWN';}
    for(const reason of report.reason_codes)reasons.add(reason);
  }
  if(reports.length!==5||GATES.some(g=>!seen.has(g))){reasons.add('BUNDLE_INCOMPLETE_GATES');status='UNKNOWN';}
  // Informational UNKNOWN checks (e.g. unavailable retained preimages) stay separate.
  if(status==='PASS')status=valid.some(r=>r.status==='FAIL')?'FAIL':valid.some(r=>r.status==='BLOCKED')?'BLOCKED':valid.some(r=>r.status==='UNKNOWN')?'UNKNOWN':'PASS';
  const bundle:GateBundle={schema:'RBRIDGE_INSTALL_GATE_V1',status,reason_codes:[...reasons].sort(),token,reports:valid.sort((a,b)=>GATES.indexOf(a.gate)-GATES.indexOf(b.gate))};
  validateInstallContract(bundle,'GateBundle');return bundle;
}
export async function collectFirstInstallGates(context:GateContext,observations:readonly ProcessObservation[]):Promise<GateBundle>{
  const reports:GateReport[]=[];
  try{
    await matching(context);
    // Keep every returned failure report; one partial success can never become PASS.
    reports.push(await auditLegacyGate(context),await auditFlowPilotGate(context),await auditProcessGate(context,observations),await auditTransferGate(context),await auditFirstInstallCore(context));
    await matching(context);return validateFirstInstallGateBundle(reports,context.token);
  }catch{
    return {schema:'RBRIDGE_INSTALL_GATE_V1',status:'UNKNOWN',reason_codes:['BUNDLE_SNAPSHOT_OR_REPORT_UNAVAILABLE'],token:context.token,reports};
  }
}
