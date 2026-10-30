import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readSync} from 'node:fs';

export const RBRIDGE_OWNER_HOLD_PATH='/etc/rbridge/owner-app-run-hold-v1.json';
const SHA=/^[0-9a-f]{64}$/,APP=/^[a-z][a-z0-9_-]{0,31}$/,REQUEST=/^[a-z0-9][a-z0-9._:-]{0,127}$/,JOB=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const REQUIRED_APPS=['aplall','dart','editor'] as const;
const EXPECTED_COUNTS:Record<string,number>={aplall:3,dart:2,editor:4};
const MAX_BYTES=32768;
export interface OwnerHoldIdentity {appId:string;requestId:string;jobId:string;issueNumber:number;requestSha256:string;}
interface HoldOriginal extends OwnerHoldIdentity {storeSha256:string;phase:'WAITING';scope:'UNSCOPED';}
export interface OwnerHoldManifest {schema:'RBRIDGE_OWNER_APP_RUN_HOLD_V1';mode:'HOLD';repository:string;authorLogin:string;instanceId:string;apps:string[];originals:HoldOriginal[];}
export interface OwnerHoldContext {expectedSha256:string|undefined;repository:string;authorLogin:string;instanceId:string;runtimeUid:number;runtimeGid:number;}
function fail(code:string):never{throw new Error(code);}
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_OWNER_HOLD_RECORD_INVALID');return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,keys:string[]):void{if(Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail('RBRIDGE_OWNER_HOLD_FIELDS_INVALID');}
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object'){const x=value as Record<string,unknown>;return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));}return value;}
function hash(value:Buffer):string{return createHash('sha256').update(value).digest('hex');}
function validateContext(context:OwnerHoldContext):void{
  if(typeof context.expectedSha256!=='string'||!SHA.test(context.expectedSha256))fail('RBRIDGE_OWNER_HOLD_PIN_REQUIRED');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository)||!/^[A-Za-z0-9-]{1,39}$/.test(context.authorLogin)||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.instanceId))fail('RBRIDGE_OWNER_HOLD_CONTEXT_INVALID');
  if(!Number.isSafeInteger(context.runtimeUid)||context.runtimeUid<=0||!Number.isSafeInteger(context.runtimeGid)||context.runtimeGid<=0)fail('RBRIDGE_OWNER_HOLD_RUNTIME_ID_INVALID');
}
/** Parse ONLY a SHA-pinned canonical root-owned HOLD. Never accepts a release/unhold mode. */
export function validateOwnerHoldManifest(raw:Buffer,context:OwnerHoldContext):OwnerHoldManifest{
  validateContext(context);
  if(raw.length<1||raw.length>MAX_BYTES||hash(raw)!==context.expectedSha256)fail('RBRIDGE_OWNER_HOLD_DIGEST_MISMATCH');
  let parsed:unknown;try{parsed=JSON.parse(raw.toString('utf8'));}catch{fail('RBRIDGE_OWNER_HOLD_JSON_INVALID');}
  const row=object(parsed);
  fields(row,['schema','mode','repository','authorLogin','instanceId','apps','originals']);
  if(row.schema!=='RBRIDGE_OWNER_APP_RUN_HOLD_V1'||row.mode!=='HOLD'||row.repository!==context.repository||row.authorLogin!==context.authorLogin||row.instanceId!==context.instanceId)fail('RBRIDGE_OWNER_HOLD_SCOPE_INVALID');
  if(!Array.isArray(row.apps)||row.apps.length!==3||row.apps.some(x=>typeof x!=='string'||!APP.test(x))||JSON.stringify([...row.apps].sort())!==JSON.stringify(REQUIRED_APPS))fail('RBRIDGE_OWNER_HOLD_APPS_INVALID');
  if(!Array.isArray(row.originals)||row.originals.length!==9)fail('RBRIDGE_OWNER_HOLD_ORIGINALS_INVALID');
  const byApp:Record<string,number>={aplall:0,dart:0,editor:0},issues=new Set<number>(),ids=new Set<string>(),jobs=new Set<string>();
  let previous=0;
  for(const item of row.originals){
    const r=object(item);fields(r,['appId','requestId','jobId','issueNumber','requestSha256','storeSha256','phase','scope']);
    if(typeof r.appId!=='string'||!(r.appId in byApp)||typeof r.requestId!=='string'||!REQUEST.test(r.requestId)||typeof r.jobId!=='string'||!JOB.test(r.jobId)
       ||!Number.isSafeInteger(r.issueNumber)||Number(r.issueNumber)<=previous
       ||typeof r.requestSha256!=='string'||!SHA.test(r.requestSha256)
       ||typeof r.storeSha256!=='string'||!SHA.test(r.storeSha256)
       ||r.phase!=='WAITING'||r.scope!=='UNSCOPED'
       ||issues.has(Number(r.issueNumber))||ids.has(r.requestId)||jobs.has(r.appId+'\0'+r.jobId))fail('RBRIDGE_OWNER_HOLD_ORIGINALS_INVALID');
    previous=Number(r.issueNumber);issues.add(previous);ids.add(r.requestId);jobs.add(r.appId+'\0'+r.jobId);byApp[r.appId]=(byApp[r.appId]??0)+1;
  }
  if(REQUIRED_APPS.some(app=>byApp[app]!==EXPECTED_COUNTS[app]))fail('RBRIDGE_OWNER_HOLD_ORIGINALS_INVALID');
  if(raw.toString('utf8')!==JSON.stringify(canonical(parsed))+'\n')fail('RBRIDGE_OWNER_HOLD_CANONICAL_INVALID');
  return parsed as OwnerHoldManifest;
}
function signature(s:{dev:bigint;ino:bigint;uid:bigint;gid:bigint;mode:bigint;nlink:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}):string{return [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join('/');}
function trustedParent(path:string):string{
  const s=lstatSync(path,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0n||(s.mode&0o022n)!==0n)fail('RBRIDGE_OWNER_HOLD_PARENT_UNTRUSTED');
  return signature(s);
}
/** Synchronous, fixed-path, bounded read. No filesystem write, controller call or ROOT action. */
export function loadProtectedOwnerHold(context:OwnerHoldContext):OwnerHoldManifest{
  validateContext(context);
  const root=trustedParent('/'),etc=trustedParent('/etc'),folder=trustedParent('/etc/rbridge');
  const file=RBRIDGE_OWNER_HOLD_PATH,before=lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==0n||before.gid!==BigInt(context.runtimeGid)||(before.mode&0o777n)!==0o640n||before.nlink!==1n||before.size<1n||before.size>BigInt(MAX_BYTES))fail('RBRIDGE_OWNER_HOLD_FILE_UNTRUSTED');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|0o2000000 /* Linux O_CLOEXEC */);
  let current,after,data:Buffer;
  try{
    current=fstatSync(fd,{bigint:true});
    data=Buffer.alloc(Number(before.size));
    let offset=0;
    while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,offset);if(n<=0)fail('RBRIDGE_OWNER_HOLD_READ_INCOMPLETE');offset+=n;}
    const extra=Buffer.alloc(1);
    if(readSync(fd,extra,0,1,data.length)!==0)fail('RBRIDGE_OWNER_HOLD_FILE_CHANGED');
    after=fstatSync(fd,{bigint:true});
  }finally{closeSync(fd);}
  if(signature(before)!==signature(current)||signature(current)!==signature(after)||signature(after)!==signature(lstatSync(file,{bigint:true}))
    ||trustedParent('/')!==root||trustedParent('/etc')!==etc||trustedParent('/etc/rbridge')!==folder)fail('RBRIDGE_OWNER_HOLD_FILE_CHANGED');
  return validateOwnerHoldManifest(data,context);
}
/** Held apps NEVER become released by expiry, missing file, policy drift or failed recheck. */
export function createPinnedOwnerHoldDecision(manifest:OwnerHoldManifest,recheck:()=>unknown):(identity:Readonly<OwnerHoldIdentity>)=>Promise<boolean>{
  const held=new Set(manifest.apps);
  return async identity=>{
    if(typeof identity.appId!=='string'||!APP.test(identity.appId))throw Error('RBRIDGE_OWNER_HOLD_APP_ID_INVALID');
    if(!held.has(identity.appId))return false;
    try{recheck();}catch{return true;}
    return true;
  };
}
export function createProtectedOwnerHold(context:OwnerHoldContext):(identity:Readonly<OwnerHoldIdentity>)=>Promise<boolean>{
  const manifest=loadProtectedOwnerHold(context); // startup fails CLOSED unless root-owned pinned HOLD exists
  return createPinnedOwnerHoldDecision(manifest,()=>loadProtectedOwnerHold(context));
}
