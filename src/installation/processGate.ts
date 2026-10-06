import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {resolveRemoteBridgeProcessCommandProfile} from '../domain/remoteBridgeHostProfiles.js';
import {gateReport,installHash,type GateContext} from './gateContext.js';
import {parseStrictJson} from './strictJson.js';
import {validateInstallContract,type GateReport,type ProcessObservation} from './types.js';

const ID=/^[0-9a-f]{32}$/,HASH=/^[0-9a-f]{64}$/;
function fail(reason:string):never{throw new Error(reason);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('PROCESS_RECORD_INVALID');return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,required:readonly string[]){if(required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)))fail('PROCESS_FIELDS_INVALID');}
function date(value:unknown):number{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('PROCESS_TIMESTAMP_INVALID');return Date.parse(value);}
function integer(value:unknown,min:number,max:number){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;}
function path(value:unknown):value is string{return typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&!/[\x00\r\n]/.test(value)&&!value.split('/').slice(1).some(p=>!p||p==='.'||p==='..');}
const hash=(value:unknown)=>typeof value==='string'&&HASH.test(value);
async function read(context:GateContext,name:string){
  const entry=context.snapshot.entries.find(e=>e.path===name);
  if(!entry||entry.kind!=='FILE'||entry.mode!==0o600||entry.nlink!==1||entry.size>context.profile.budget.record_bytes)fail('PROCESS_REQUIRED_FILE_INVALID');
  return object(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(await context.snapshot.read(name))));
}
function spec(value:Record<string,unknown>,id:string,context:GateContext){
  fields(value,['schema','sessionId','ownerDigest','profileId','executable','args','cwd','createdAt','expiresAt','maxOutputBytes','stdinMode','maxInputBytes','forceKillAfterMs','sessionDir','recordPath','outputPath','socketPath']);
  if(value.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_V1'||value.sessionId!==id||!hash(value.ownerDigest)||typeof value.profileId!=='string'||!Array.isArray(value.args)||!path(value.cwd))fail('PROCESS_SPEC_INVALID');
  // The echo profile stores its source-controlled expanded arguments, not request argv.
  const profile=resolveRemoteBridgeProcessCommandProfile(value.profileId,value.profileId==='stdin-echo'?[]:value.args);
  if(value.executable!==profile.executable||installHash(value.args)!==installHash(profile.args)||value.maxOutputBytes!==profile.maxOutputBytes||value.stdinMode!==profile.stdinMode||value.maxInputBytes!==profile.maxInputBytes||value.forceKillAfterMs!==profile.forceKillAfterMs||!profile.cwdRoots.some(root=>value.cwd===root||(value.cwd as string).startsWith(root+'/')))fail('PROCESS_PROFILE_MISMATCH');
  const lifetime=date(value.expiresAt)-date(value.createdAt);if(lifetime<1000||lifetime>profile.maxLifetimeMs)fail('PROCESS_LIFETIME_INVALID');
  const root=context.profile.paths.state_root+'/sessions/'+id;
  if(value.sessionDir!==root||value.recordPath!==root+'/record.json'||value.outputPath!==root+'/output.ndjson'||value.socketPath!==root+'/control.sock')fail('PROCESS_SPEC_PATH_MISMATCH');
  return profile;
}
function record(value:Record<string,unknown>,s:Record<string,unknown>){
  fields(value,['schema','sessionId','ownerDigest','profileId','state','createdAt','updatedAt','expiresAt','pid','identity','outputBytes','truncated','stdinAttached','exitCode','signal','reason','receipts']);
  if(value.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1'||['sessionId','ownerDigest','profileId','createdAt','expiresAt'].some(k=>value[k]!==s[k])||date(value.updatedAt)<date(value.createdAt)||!integer(value.outputBytes,0,Number(s.maxOutputBytes))||typeof value.truncated!=='boolean'||typeof value.stdinAttached!=='boolean'||(value.pid!==null&&!integer(value.pid,2,2147483647))||(value.exitCode!==null&&!integer(value.exitCode,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))||(value.signal!==null&&(typeof value.signal!=='string'||!/^SIG[A-Z0-9]+$/.test(value.signal)))||(value.reason!==null&&(typeof value.reason!=='string'||Buffer.byteLength(value.reason)>2048||value.reason.includes('\0'))))fail('PROCESS_RECORD_IDENTITY_INVALID');
  if(!['SUCCEEDED','FAILED','TERMINATED'].includes(String(value.state))||value.truncated||value.stdinAttached)fail('PROCESS_UNSETTLED_OR_TRUNCATED');
  if(value.state==='SUCCEEDED'&&(value.exitCode!==0||value.signal!==null||value.reason!==null))fail('PROCESS_EXIT_OUTCOME_MISMATCH');
  const receipts=object(value.receipts);if(Object.entries(receipts).some(([key,state])=>!HASH.test(key)||state!=='DONE'))fail('PROCESS_ACTION_RECEIPT_UNSETTLED');
  if(value.identity!==null){
    const identity=object(value.identity);fields(identity,['pid','startTimeTicks','exe','cmdlineSha256']);
    const expectedCommand=createHash('sha256').update([s.executable,...s.args as string[]].join('\0')+'\0').digest('hex');
    if(identity.pid!==value.pid||typeof identity.startTimeTicks!=='string'||!/^[1-9][0-9]{0,31}$/.test(identity.startTimeTicks)||identity.exe!==s.executable||identity.cmdlineSha256!==expectedCommand)fail('PROCESS_PID_IDENTITY_INVALID');
  }else if(value.pid===null&&(value.state!=='FAILED'||value.exitCode!==null||value.signal!==null||typeof value.reason!=='string'||!value.reason||value.outputBytes!==0))fail('PROCESS_PID_IDENTITY_MISSING');
}
function observation(context:GateContext,id:string,r:Record<string,unknown>,o:ProcessObservation|undefined){
  if(!o)fail('PROCESS_OBSERVATION_MISSING');validateInstallContract(o,'ProcessObservation');
  const identity=r.identity===null?null:object(r.identity),expectedPID=r.pid===null?0:Number(r.pid),expectedTicks=identity?String(identity.startTimeTicks):'0';
  if(o.session_id!==id||o.pid!==expectedPID||o.start_ticks!==expectedTicks||o.identity_sha256!==installHash(identity)||o.snapshot_sha256!==installHash(context.token)||o.profile_sha256!==installHash(context.profile)||(context.snapshot.scope==='QUALIFIED_READONLY_HELPER'&&o.scope!=='QUALIFIED_HOST_PROCESS'))fail('PROCESS_OBSERVATION_IDENTITY_MISMATCH');
  const observed=date(o.observed_at),captured=date(context.token.captured_at);if(observed<captured||observed-captured>context.profile.budget.maintenance_ms)fail('PROCESS_OBSERVATION_STALE');
  if(o.cgroup&&(!path(o.cgroup)||!o.cgroup.startsWith(`/user.slice/user-${context.profile.binding.uid}.slice/user@${context.profile.binding.uid}.service/`)||!o.cgroup.endsWith(`/cocwin-remote-bridge-process-${id}.service`)))fail('PROCESS_CGROUP_IDENTITY_MISMATCH');
  if(o.process_state!=='ABSENT'||!o.settled||!o.cgroup_settled)fail('PROCESS_KERNEL_OR_CGROUP_UNSETTLED');
  if(o.observed_identity_sha256!==installHash(null))fail('PROCESS_OBSERVATION_IDENTITY_MISMATCH');
}
async function log(context:GateContext,id:string,r:Record<string,unknown>,maximum:number,started:number){
  const entry=context.snapshot.entries.find(e=>e.path===`sessions/${id}/output.ndjson`);
  if(!entry||entry.kind!=='FILE'||entry.mode!==0o600||entry.nlink!==1||entry.size>context.profile.budget.process_log_bytes)fail('PROCESS_OUTPUT_LOG_INVALID');
  const bytes=await context.snapshot.read(entry.path,context.profile.budget.process_log_bytes);
  if(bytes.length&&bytes.at(-1)!==10)fail('PROCESS_OUTPUT_PARTIAL_FRAME');
  let frames=0,total=0;const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  for(const line of raw?raw.slice(0,-1).split('\n'):[]){
    if(++frames>context.profile.budget.process_frames||performance.now()-started>=context.profile.budget.scan_ms)fail('PROCESS_OUTPUT_BUDGET');
    if(!line||Buffer.byteLength(line)>8192)fail('PROCESS_OUTPUT_FRAME_INVALID');
    const frame=object(parseStrictJson(line));fields(frame,['stream','dataBase64']);
    if(!['stdout','stderr'].includes(String(frame.stream))||typeof frame.dataBase64!=='string'||!frame.dataBase64)fail('PROCESS_OUTPUT_FRAME_INVALID');
    const decoded=Buffer.from(frame.dataBase64,'base64');
    if(decoded.length<1||decoded.length>4096||decoded.toString('base64')!==frame.dataBase64)fail('PROCESS_OUTPUT_BASE64_INVALID');
    total+=decoded.length;if(total>maximum)fail('PROCESS_OUTPUT_DECODED_LIMIT');
  }
  if(total!==r.outputBytes)fail('PROCESS_OUTPUT_ACCOUNTING_MISMATCH');return {sha256:entry.sha256,decoded_bytes:total,frames};
}

export interface ProcessProbeTarget{session_id:string;pid:number;start_ticks:string;identity_sha256:string;}
export async function collectProcessProbeTargets(context:GateContext):Promise<readonly ProcessProbeTarget[]>{
  await context.snapshot.verify();
  if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes||context.snapshot.reasonCodes.length)fail('PROCESS_DISCOVERY_SNAPSHOT_UNQUALIFIED');
  const ids=new Set<string>(),claims=new Map<string,Record<string,unknown>>(),owned=new Set<string>(),started=performance.now();
  for(const entry of context.snapshot.entries.filter(e=>e.path==='sessions'||e.path.startsWith('sessions/'))){
    if(performance.now()-started>=context.profile.budget.scan_ms)fail('PROCESS_SCAN_DEADLINE');
    const parts=entry.path.split('/');
    if(parts.length===1||parts.length===2&&parts[1]==='start-claims'){
      if(entry.kind!=='DIRECTORY'||entry.mode!==0o700)fail('PROCESS_DIRECTORY_INVALID');continue;
    }
    if(parts[1]==='start-claims'){
      if(parts.length!==3||!/^[0-9a-f]{64}\.json$/.test(parts[2]!))fail('PROCESS_UNKNOWN_CLAIM');
      const claim=await read(context,entry.path);fields(claim,['schema','ownerDigest','sessionId','profileId','createdAt']);
      if(claim.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1'||claim.ownerDigest!==parts[2]!.slice(0,-5)||typeof claim.sessionId!=='string'||!ID.test(claim.sessionId)||typeof claim.profileId!=='string'||owned.has(claim.sessionId))fail('PROCESS_CLAIM_IDENTITY_INVALID');
      date(claim.createdAt);owned.add(claim.sessionId);claims.set(String(claim.ownerDigest),claim);continue;
    }
    if(!ID.test(parts[1]??''))fail('PROCESS_UNKNOWN_SESSION');
    if(parts.length===2){if(entry.kind!=='DIRECTORY'||entry.mode!==0o700)fail('PROCESS_DIRECTORY_INVALID');ids.add(parts[1]!);}
    else if(parts.length!==3||!['spec.json','record.json','output.ndjson','control.sock'].includes(parts[2]!))fail('PROCESS_UNKNOWN_OR_INTERRUPTED_ENTRY');
  }
  const targets:ProcessProbeTarget[]=[];
  for(const id of [...ids].sort()){
    if(performance.now()-started>=context.profile.budget.scan_ms)fail('PROCESS_SCAN_DEADLINE');
    const s=await read(context,`sessions/${id}/spec.json`);spec(s,id,context);const r=await read(context,`sessions/${id}/record.json`);record(r,s);
    const claim=claims.get(String(s.ownerDigest));if(!claim||['sessionId','profileId','createdAt','ownerDigest'].some(k=>claim[k]!==s[k]))fail('PROCESS_CLAIM_SPEC_RECORD_MISMATCH');claims.delete(String(s.ownerDigest));
    const identity=r.identity===null?null:object(r.identity);
    targets.push({session_id:id,pid:r.pid===null?0:Number(r.pid),start_ticks:identity?String(identity.startTimeTicks):'0',identity_sha256:installHash(identity)});
  }
  if(claims.size)fail('PROCESS_ORPHAN_START_CLAIM');await context.snapshot.verify();return Object.freeze(targets.map(target=>Object.freeze(target)));
}

export async function auditProcessGate(context:GateContext,observations:readonly ProcessObservation[]):Promise<GateReport>{
  const evidence:Array<{session_id:string;record_sha256:string;spec_sha256:string;observation_sha256:string;identity_recorded:boolean;terminal_state:string;log:unknown}>=[],started=performance.now();
  try{
    await context.snapshot.verify();
    if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes)fail('PROCESS_SNAPSHOT_MISMATCH');
    if(context.snapshot.reasonCodes.length)return gateReport(context,'PROCESS','BLOCKED',context.snapshot.reasonCodes);
    const root=context.snapshot.entries.find(e=>e.path==='sessions');if(root&&(root.kind!=='DIRECTORY'||root.mode!==0o700))fail('PROCESS_DIRECTORY_INVALID');
    const claimsRoot=context.snapshot.entries.find(e=>e.path==='sessions/start-claims');if(claimsRoot&&(claimsRoot.kind!=='DIRECTORY'||claimsRoot.mode!==0o700))fail('PROCESS_CLAIMS_DIRECTORY_INVALID');
    const ids=new Set<string>(),claims=new Map<string,Record<string,unknown>>(),owned=new Set<string>();
    for(const entry of context.snapshot.entries.filter(e=>e.path.startsWith('sessions/'))){
      const parts=entry.path.split('/');
      if(parts[1]==='start-claims'){
        if(parts.length===2)continue;
        if(parts.length!==3||! /^[0-9a-f]{64}\.json$/.test(parts[2]!))fail('PROCESS_UNKNOWN_CLAIM');
        const claim=await read(context,entry.path);fields(claim,['schema','ownerDigest','sessionId','profileId','createdAt']);
        if(claim.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1'||claim.ownerDigest!==parts[2]!.slice(0,-5)||typeof claim.sessionId!=='string'||!ID.test(claim.sessionId)||typeof claim.profileId!=='string'||owned.has(claim.sessionId))fail('PROCESS_CLAIM_IDENTITY_INVALID');date(claim.createdAt);owned.add(claim.sessionId);claims.set(String(claim.ownerDigest),claim);
      }else{
        if(!ID.test(parts[1]??''))fail('PROCESS_UNKNOWN_SESSION');
        if(parts.length===2){if(entry.kind!=='DIRECTORY'||entry.mode!==0o700)fail('PROCESS_DIRECTORY_INVALID');ids.add(parts[1]!);}
        else if(parts.length!==3||!['spec.json','record.json','output.ndjson','control.sock'].includes(parts[2]!))fail('PROCESS_UNKNOWN_OR_INTERRUPTED_ENTRY');
        else if(parts[2]==='control.sock'&&(entry.kind!=='SOCKET'||entry.mode!==0o600))fail('PROCESS_SOCKET_UNCLASSIFIED');
      }
    }
    const observed=new Map<string,ProcessObservation>();for(const o of observations){validateInstallContract(o,'ProcessObservation');if(observed.has(o.session_id)||!ids.has(o.session_id))fail('PROCESS_OBSERVATION_EXTRA_OR_DUPLICATE');observed.set(o.session_id,o);}
    for(const id of [...ids].sort()){
      if(performance.now()-started>=context.profile.budget.scan_ms)fail('PROCESS_SCAN_DEADLINE');
      const s=await read(context,`sessions/${id}/spec.json`),profile=spec(s,id,context),r=await read(context,`sessions/${id}/record.json`);record(r,s);
      const claim=claims.get(String(s.ownerDigest));if(!claim||['sessionId','profileId','createdAt','ownerDigest'].some(k=>claim[k]!==s[k]))fail('PROCESS_CLAIM_SPEC_RECORD_MISMATCH');
      observation(context,id,r,observed.get(id));claims.delete(String(s.ownerDigest));
      const output=await log(context,id,r,profile.maxOutputBytes,started);
      evidence.push({session_id:id,record_sha256:context.snapshot.entries.find(e=>e.path===`sessions/${id}/record.json`)!.sha256,spec_sha256:context.snapshot.entries.find(e=>e.path===`sessions/${id}/spec.json`)!.sha256,observation_sha256:installHash(observed.get(id)),identity_recorded:r.identity!==null,terminal_state:String(r.state),log:output});
    }
    if(claims.size)fail('PROCESS_ORPHAN_START_CLAIM');await context.snapshot.verify();
    return gateReport(context,'PROCESS','PASS',[],[{name:'complete-history-and-kernel-settlement',status:'PASS',evidence_sha256:installHash(evidence)}],evidence);
  }catch(error){
    const reason=error instanceof Error&&/^(?:PROCESS|STATE|INSTALL_JSON)_[A-Z_]+$/.test(error.message)?error.message:'PROCESS_PARSE_OR_OBSERVATION_UNAVAILABLE';
    return gateReport(context,'PROCESS',reason.startsWith('STATE_')||reason==='PROCESS_OBSERVATION_MISSING'?'UNKNOWN':'BLOCKED',[reason],[],evidence);
  }
}
