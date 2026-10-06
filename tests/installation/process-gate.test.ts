import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {resolveRemoteBridgeProcessCommandProfile} from '../../src/domain/remoteBridgeHostProfiles.js';
import {auditProcessGate,collectProcessProbeTargets} from '../../src/installation/processGate.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {ProcessObservation} from '../../src/installation/types.js';
import {fixtureGateContext} from './fixtureContext.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(options:{malformed?:boolean;claimReceipt?:boolean;log?:string;noLog?:boolean;orphanClaim?:boolean;mutateRecord?:(row:Record<string,unknown>)=>void;mutateSpec?:(row:Record<string,unknown>)=>void}={}){
  const root=await mkdtemp(join(tmpdir(),'rbridge-process-gate-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const id='a'.repeat(32),owner='b'.repeat(64),session=join(root,'sessions',id),claims=join(root,'sessions','start-claims');await mkdir(session,{recursive:true,mode:0o700});await mkdir(claims,{mode:0o700});
  const createdAt='2026-10-05T00:00:00.000Z',expiresAt='2026-10-05T00:00:30.000Z',profile=resolveRemoteBridgeProcessCommandProfile('node-safe',['--version']),path='/home/rbridge/.local/state/rbridge/sessions/'+id;
  const spec:Record<string,unknown>={schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_V1',sessionId:id,ownerDigest:owner,profileId:profile.id,executable:profile.executable,args:profile.args,cwd:'/mnt/data',createdAt,expiresAt,maxOutputBytes:profile.maxOutputBytes,stdinMode:profile.stdinMode,maxInputBytes:profile.maxInputBytes,forceKillAfterMs:profile.forceKillAfterMs,sessionDir:path,recordPath:path+'/record.json',outputPath:path+'/output.ndjson',socketPath:path+'/control.sock'};
  const identity={pid:31337,startTimeTicks:'123456',exe:profile.executable,cmdlineSha256:createHash('sha256').update([profile.executable,...profile.args].join('\0')+'\0').digest('hex')};
  const record:Record<string,unknown>={schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1',sessionId:id,ownerDigest:owner,profileId:profile.id,state:'SUCCEEDED',createdAt,updatedAt:'2026-10-05T00:00:01.000Z',expiresAt,pid:identity.pid,identity,outputBytes:3,truncated:false,stdinAttached:false,exitCode:0,signal:null,reason:null,receipts:{...options.claimReceipt?{['d'.repeat(64)]:'CLAIMED'}:{}}};
  options.mutateRecord?.(record);options.mutateSpec?.(spec);
  await writeFile(join(claims,owner+'.json'),JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1',ownerDigest:owner,sessionId:options.orphanClaim?'e'.repeat(32):id,profileId:profile.id,createdAt}),{mode:0o600});
  await writeFile(join(session,'spec.json'),JSON.stringify(spec),{mode:0o600});await writeFile(join(session,'record.json'),options.malformed?'{}':JSON.stringify(record),{mode:0o600});
  if(!options.noLog)await writeFile(join(session,'output.ndjson'),options.log??'{"stream":"stdout","dataBase64":"YWJj"}\n',{mode:0o600});
  const context=await fixtureGateContext(root);cleanup.push(()=>context.snapshot.close());
  const observation={scope:'FIXTURE_AUTHORITY_ONLY',session_id:id,pid:record.pid??0,start_ticks:record.identity===null?'0':String((record.identity as Record<string,unknown>).startTimeTicks),cgroup:'',cgroup_settled:true,settled:true,process_state:'ABSENT',identity_sha256:installHash(record.identity),observed_identity_sha256:installHash(null),unit_sha256:'f'.repeat(64),snapshot_sha256:installHash(context.token),profile_sha256:installHash(context.profile),observed_at:'2026-10-06T00:00:01.000Z'} as ProcessObservation;
  return {context,observation,record,spec};
}
describe('complete offline process settlement',()=>{
  it('exports complete source-validated targets without claiming kernel absence',async()=>{
    const f=await fixture();expect(await collectProcessProbeTargets(f.context)).toEqual([{session_id:f.observation.session_id,pid:f.observation.pid,start_ticks:f.observation.start_ticks,identity_sha256:f.observation.identity_sha256}]);
    const fast=await fixture({mutateRecord:r=>{r.identity=null;}});expect((await collectProcessProbeTargets(fast.context))[0]!.start_ticks).toBe('0');
    const invalid=await fixture({claimReceipt:true});await expect(collectProcessProbeTargets(invalid.context)).rejects.toThrow();
  });
  it('malformed records cannot hide behind empty observations or zero stats',async()=>{
    const f=await fixture({malformed:true});expect((await auditProcessGate(f.context,[])).status).not.toBe('PASS');await f.context.snapshot.verify();
  });
  it('claimed action receipts and matching live identities block',async()=>{
    const f=await fixture({claimReceipt:true});expect((await auditProcessGate(f.context,[f.observation])).status).toBe('BLOCKED');
    const live=await fixture();expect((await auditProcessGate(live.context,[{...live.observation,process_state:'MATCHING',settled:false}])).status).toBe('BLOCKED');
  });
  it('counts decoded frame bytes rather than the NDJSON file size',async()=>{
    const f=await fixture(),before=f.context.snapshot.treeSHA256;expect((await auditProcessGate(f.context,[f.observation])).status).toBe('PASS');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);
  });
  it('orphan claims, wrong paths, corrupt base64 and missing logs block',async()=>{
    for(const options of [{orphanClaim:true},{mutateSpec:(r:Record<string,unknown>)=>{r.recordPath='/other/record.json';}},{log:'{"stream":"stdout","dataBase64":"YWJj!"}\n'},{noLog:true},{log:''}]){const f=await fixture(options);expect((await auditProcessGate(f.context,[f.observation])).status).toBe('BLOCKED');await f.context.snapshot.verify();}
  });
  it('uncertain or truncated history and missing, wrong-start or stale observations never pass',async()=>{
    for(const mutateRecord of [(r:Record<string,unknown>)=>{r.state='UNCERTAIN';},(r:Record<string,unknown>)=>{r.truncated=true;}]){const f=await fixture({mutateRecord});expect((await auditProcessGate(f.context,[f.observation])).status).toBe('BLOCKED');}
    const f=await fixture();expect((await auditProcessGate(f.context,[])).status).not.toBe('PASS');
    for(const changed of [{start_ticks:'654321'},{snapshot_sha256:'f'.repeat(64)},{cgroup_settled:false}])expect((await auditProcessGate(f.context,[{...f.observation,...changed}])).status).not.toBe('PASS');
  });
  it('rejects a command identity that does not match the fixed profile arguments',async()=>{
    const f=await fixture({mutateRecord:r=>{r.identity={...(r.identity as Record<string,unknown>),cmdlineSha256:'f'.repeat(64)};}});expect((await auditProcessGate(f.context,[f.observation])).status).toBe('BLOCKED');
  });
  it('rejects partial frames and contradictory decoded accounting unchanged',async()=>{
    for(const options of [{log:'{"stream":"stdout","dataBase64":"YWJj"}'},{log:'{"stream":"stdout","dataBase64":"YWJj","stream":"stderr"}\n'},{mutateRecord:(r:Record<string,unknown>)=>{r.outputBytes=40;}}]){const f=await fixture(options);expect((await auditProcessGate(f.context,[f.observation])).status).toBe('BLOCKED');await f.context.snapshot.verify();}
  });
  it('preserves the pinned supervisor fast-exit branch with null recorded identity',async()=>{
    const f=await fixture({mutateRecord:r=>{r.identity=null;}});expect((await auditProcessGate(f.context,[f.observation])).status).toBe('PASS');expect(f.record.identity).toBe(null);
    expect((await auditProcessGate(f.context,[{...f.observation,process_state:'REUSED',settled:false}])).status).toBe('BLOCKED');
  });
});
