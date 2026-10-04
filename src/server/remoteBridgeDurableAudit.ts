import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {promisify} from 'node:util';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const execFileAsync=promisify(execFile);
const REQUEST_PREFIX='[COCWIN BRIDGE REQUEST] ';
const IN_FLIGHT_PHASES=new Set(['CLAIMED','SUBMITTED','TERMINAL']);
const TERMINAL_SESSION_STATES=new Set(['SUCCEEDED','FAILED','TERMINATED']);
const SESSION_STATES=new Set(['STARTING','RUNNING','TERMINATING','SUCCEEDED','FAILED','TERMINATED','UNCERTAIN']);
const SESSION_ID_RE=/^[0-9a-f]{32}$/;
const SHA_RE=/^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES=2*1024*1024;

type IssueState='open'|'closed';
export interface DurableAuditIssue{
  number:number;
  state:IssueState;
  authorLogin:string;
  title:string;
  isPullRequest:boolean;
}
export type DurableAuditIssueLookup=(issueNumber:number)=>Promise<DurableAuditIssue>;

interface DurableRecord{
  requestId:string;
  issueNumber:number;
  jobId:string;
  phase:string;
  updatedAt:string;
  scopeSha256?:string;
}

export interface DurableStateAuditSummary{
  schema:'RBRIDGE_DURABLE_STATE_AUDIT_V1';
  auditStatus:'PASS'|'UNKNOWN';
  cutoverGate:'PASS'|'BLOCKED'|'UNKNOWN';
  recordsTotal:number;
  phases:Record<string,number>;
  unscopedRecords:number;
  unresolvedRecords:number;
  unresolvedOpenTrusted:number;
  unresolvedClosedTrusted:number;
  identityMismatches:number;
  lookupErrors:number;
  activeSessions:number;
  openTrusted:Array<{requestId:string;issueNumber:number;phase:string;jobId:string;updatedAt:string}>;
  identityMismatchIssues:number[];
  lookupErrorIssues:number[];
  activeSessionIds:string[];
}

function fail(code:string):never{throw new Error(code);}
function record(value:unknown,code:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  return value as Record<string,unknown>;
}
function parseDurableRecord(value:unknown):DurableRecord{
  const row=record(value,'RBRIDGE_DURABLE_AUDIT_RECORD_INVALID');
  if(row.schema!=='COCWIN_REMOTE_BRIDGE_STORE_V1')fail('RBRIDGE_DURABLE_AUDIT_RECORD_SCHEMA_INVALID');
  if(typeof row.requestId!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(row.requestId))fail('RBRIDGE_DURABLE_AUDIT_REQUEST_ID_INVALID');
  if(typeof row.requestSha256!=='string'||!SHA_RE.test(row.requestSha256))fail('RBRIDGE_DURABLE_AUDIT_DIGEST_INVALID');
  if(!Number.isSafeInteger(row.issueNumber)||Number(row.issueNumber)<1)fail('RBRIDGE_DURABLE_AUDIT_ISSUE_NUMBER_INVALID');
  if(typeof row.jobId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.jobId))fail('RBRIDGE_DURABLE_AUDIT_JOB_ID_INVALID');
  if(typeof row.phase!=='string'||!['CLAIMED','SUBMITTED','TERMINAL','PUBLISHED'].includes(row.phase))fail('RBRIDGE_DURABLE_AUDIT_PHASE_INVALID');
  if(typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt)))fail('RBRIDGE_DURABLE_AUDIT_UPDATED_AT_INVALID');
  if(row.scopeSha256!==undefined&&(typeof row.scopeSha256!=='string'||!/^[0-9a-f]{64}$/.test(row.scopeSha256)))fail('RBRIDGE_DURABLE_AUDIT_SCOPE_INVALID');
  return {
    requestId:row.requestId,
    issueNumber:Number(row.issueNumber),
    jobId:row.jobId,
    phase:row.phase,
    updatedAt:row.updatedAt,
    ...(typeof row.scopeSha256==='string'?{scopeSha256:row.scopeSha256}:{}),
  };
}
async function readJsonFile(path:string):Promise<unknown>{
  let handle;
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){if((error as NodeJS.ErrnoException)?.code==='ELOOP')fail('RBRIDGE_DURABLE_AUDIT_FILE_INVALID');throw error;}
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.nlink!==1||info.size>MAX_RECORD_BYTES)fail('RBRIDGE_DURABLE_AUDIT_FILE_INVALID');
    const buffer=Buffer.alloc(Math.min(info.size+1,MAX_RECORD_BYTES+1));let offset=0;
    while(offset<buffer.length){
      const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);
      if(bytesRead===0)break;offset+=bytesRead;
    }
    if(offset>info.size)fail('RBRIDGE_DURABLE_AUDIT_SNAPSHOT_CHANGED');
    return JSON.parse(buffer.subarray(0,offset).toString('utf8')) as unknown;
  }finally{await handle.close();}
}

// Detect changes during this observation. A deployment must still quiesce writers
// and repeat the audit immediately before switching the production release.
async function stateSnapshot(root:string):Promise<string>{
  const evidence:string[][]=[];
  async function capture(path:string,kind:'file'|'directory',code:string){
    let info;
    try{info=await lstat(path,{bigint:true});}
    catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')fail(code);throw error;}
    if(info.isSymbolicLink()||(kind==='file'?!info.isFile():!info.isDirectory()))fail(code);
    evidence.push([path,String(info.dev),String(info.ino),String(info.size),String(info.mtimeNs),String(info.ctimeNs)]);
  }
  await capture(root,'directory','RBRIDGE_DURABLE_AUDIT_STATE_ROOT_INVALID');
  for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.name.endsWith('.json'))await capture(join(root,entry.name),'file','RBRIDGE_DURABLE_AUDIT_FILE_INVALID');
  }
  const sessions=join(root,'sessions');
  try{await lstat(sessions);}
  catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');throw error;}
  await capture(sessions,'directory','RBRIDGE_DURABLE_AUDIT_SESSION_ROOT_INVALID');
  for(const entry of (await readdir(sessions,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const dir=join(sessions,entry.name);
    await capture(dir,'directory','RBRIDGE_DURABLE_AUDIT_SESSION_INVALID');
    if(entry.name==='start-claims'){
      for(const claim of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        if(claim.name.endsWith('.json'))await capture(join(dir,claim.name),'file','RBRIDGE_DURABLE_AUDIT_FILE_INVALID');
      }
    }else{
      if(!SESSION_ID_RE.test(entry.name))fail('RBRIDGE_DURABLE_AUDIT_SESSION_INVALID');
      await capture(join(dir,'record.json'),'file','RBRIDGE_DURABLE_AUDIT_SESSION_RECORD_MISSING');
    }
  }
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
async function mapLimit<T,R>(items:readonly T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
  const output=new Array<R>(items.length);
  let next=0;
  async function worker(){
    while(true){
      const index=next++;
      if(index>=items.length)return;
      output[index]=await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},()=>worker()));
  return output;
}

export async function createGitHubIssueLookup(options:{repository:string;ghPath?:string}):Promise<DurableAuditIssueLookup>{
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository))fail('RBRIDGE_DURABLE_AUDIT_REPOSITORY_INVALID');
  const ghPath=options.ghPath??'gh';
  return async(issueNumber:number)=>{
    const {stdout}=await execFileAsync(ghPath,['api',`repos/${options.repository}/issues/${issueNumber}`],{
      encoding:'utf8',maxBuffer:2*1024*1024,timeout:15000,env:process.env
    });
    const row=record(JSON.parse(stdout) as unknown,'RBRIDGE_DURABLE_AUDIT_GITHUB_RESPONSE_INVALID');
    if(Number(row.number)!==issueNumber||!['open','closed'].includes(String(row.state)))fail('RBRIDGE_DURABLE_AUDIT_GITHUB_IDENTITY_INVALID');
    const user=record(row.user,'RBRIDGE_DURABLE_AUDIT_GITHUB_USER_INVALID');
    if(typeof user.login!=='string'||typeof row.title!=='string')fail('RBRIDGE_DURABLE_AUDIT_GITHUB_RESPONSE_INVALID');
    return {
      number:issueNumber,
      state:row.state as IssueState,
      authorLogin:user.login,
      title:row.title,
      isPullRequest:Object.hasOwn(row,'pull_request'),
    };
  };
}

export async function auditRemoteBridgeDurableState(options:{
  stateRoot:string;
  expectedAuthor:string;
  issueLookup:DurableAuditIssueLookup;
  lookupConcurrency?:number;
}):Promise<DurableStateAuditSummary>{
  if(typeof options.stateRoot!=='string'||!options.stateRoot.startsWith('/')||options.stateRoot.includes('\0'))fail('RBRIDGE_DURABLE_AUDIT_STATE_ROOT_INVALID');
  if(resolve(options.stateRoot)!==options.stateRoot||await realpath(options.stateRoot)!==options.stateRoot)fail('RBRIDGE_DURABLE_AUDIT_STATE_ROOT_INVALID');
  if(!/^[A-Za-z0-9-]{1,39}$/.test(options.expectedAuthor))fail('RBRIDGE_DURABLE_AUDIT_AUTHOR_INVALID');
  const concurrency=options.lookupConcurrency??8;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>16)fail('RBRIDGE_DURABLE_AUDIT_CONCURRENCY_INVALID');
  const rootInfo=await lstat(options.stateRoot);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())fail('RBRIDGE_DURABLE_AUDIT_STATE_ROOT_INVALID');
  const snapshot=await stateSnapshot(options.stateRoot);

  const phases:Record<string,number>={};
  const records:DurableRecord[]=[];
  let unscopedRecords=0;
  const entries=await readdir(options.stateRoot,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(!entry.name.endsWith('.json'))continue;
    const parsed=parseDurableRecord(await readJsonFile(join(options.stateRoot,entry.name)));
    if(entry.name!==parsed.requestId+'.json')fail('RBRIDGE_DURABLE_AUDIT_FILENAME_MISMATCH');
    records.push(parsed);
    phases[parsed.phase]=(phases[parsed.phase]??0)+1;
    if(!parsed.scopeSha256)unscopedRecords++;
  }

  const unresolved=records.filter(row=>IN_FLIGHT_PHASES.has(row.phase));
  const issueNumbers=[...new Set(unresolved.map(row=>row.issueNumber))].sort((a,b)=>a-b);
  const issueMap=new Map<number,DurableAuditIssue>();
  const lookupErrorIssues:number[]=[];
  await mapLimit(issueNumbers,concurrency,async issueNumber=>{
    try{issueMap.set(issueNumber,await options.issueLookup(issueNumber));}
    catch{lookupErrorIssues.push(issueNumber);}
    return undefined;
  });

  let unresolvedOpenTrusted=0,unresolvedClosedTrusted=0,identityMismatches=0;
  const openTrusted:DurableStateAuditSummary['openTrusted']=[];
  const mismatchSet=new Set<number>();
  for(const row of unresolved){
    const issue=issueMap.get(row.issueNumber);
    if(!issue)continue;
    const identityOk=!issue.isPullRequest&&issue.authorLogin===options.expectedAuthor&&issue.title===REQUEST_PREFIX+row.requestId;
    if(!identityOk){
      identityMismatches++;
      mismatchSet.add(row.issueNumber);
      continue;
    }
    if(issue.state==='open'){
      unresolvedOpenTrusted++;
      openTrusted.push({requestId:row.requestId,issueNumber:row.issueNumber,phase:row.phase,jobId:row.jobId,updatedAt:row.updatedAt});
    }else unresolvedClosedTrusted++;
  }

  const activeSessionIds:string[]=[];
  const sessionOwners=new Map<string,string>();
  const sessionsRoot=join(options.stateRoot,'sessions');
  try{
    const sessionEntries=await readdir(sessionsRoot,{withFileTypes:true});
    for(const entry of sessionEntries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name==='start-claims')continue;
      const path=join(sessionsRoot,entry.name,'record.json');
      try{
        const row=record(await readJsonFile(path),'RBRIDGE_DURABLE_AUDIT_SESSION_INVALID');
        if(row.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1'||row.sessionId!==entry.name
          ||typeof row.ownerDigest!=='string'||!SHA_RE.test(row.ownerDigest)
          ||typeof row.state!=='string'||!SESSION_STATES.has(row.state))fail('RBRIDGE_DURABLE_AUDIT_SESSION_INVALID');
        sessionOwners.set(entry.name,row.ownerDigest);
        if(!TERMINAL_SESSION_STATES.has(row.state))activeSessionIds.push(entry.name);
      }catch(error){
        if((error as NodeJS.ErrnoException)?.code==='ENOENT')fail('RBRIDGE_DURABLE_AUDIT_SESSION_RECORD_MISSING');
        throw error;
      }
    }
  }catch(error){
    if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;
  }
  const claimsRoot=join(sessionsRoot,'start-claims');
  let claims:string[]=[];
  try{claims=await readdir(claimsRoot);}
  catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
  for(const name of claims){
    if(!name.endsWith('.json'))continue;
    const row=record(await readJsonFile(join(claimsRoot,name)),'RBRIDGE_DURABLE_AUDIT_START_CLAIM_INVALID');
    if(row.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1'
      ||typeof row.ownerDigest!=='string'||!SHA_RE.test(row.ownerDigest)||name!==row.ownerDigest+'.json'
      ||typeof row.sessionId!=='string'||!SESSION_ID_RE.test(row.sessionId))fail('RBRIDGE_DURABLE_AUDIT_START_CLAIM_INVALID');
    if(!sessionOwners.has(row.sessionId))fail('RBRIDGE_DURABLE_AUDIT_SESSION_RECORD_MISSING');
    if(sessionOwners.get(row.sessionId)!==row.ownerDigest)fail('RBRIDGE_DURABLE_AUDIT_START_CLAIM_INVALID');
  }
  if(await stateSnapshot(options.stateRoot)!==snapshot)fail('RBRIDGE_DURABLE_AUDIT_SNAPSHOT_CHANGED');

  const lookupErrors=lookupErrorIssues.length;
  const auditStatus=lookupErrors===0?'PASS':'UNKNOWN';
  const cutoverGate=lookupErrors>0?'UNKNOWN':
    (unresolvedOpenTrusted===0&&identityMismatches===0&&activeSessionIds.length===0?'PASS':'BLOCKED');

  return {
    schema:'RBRIDGE_DURABLE_STATE_AUDIT_V1',
    auditStatus,
    cutoverGate,
    recordsTotal:records.length,
    phases,
    unscopedRecords,
    unresolvedRecords:unresolved.length,
    unresolvedOpenTrusted,
    unresolvedClosedTrusted,
    identityMismatches,
    lookupErrors,
    activeSessions:activeSessionIds.length,
    openTrusted:openTrusted.sort((a,b)=>a.issueNumber-b.issueNumber||a.requestId.localeCompare(b.requestId)),
    identityMismatchIssues:[...mismatchSet].sort((a,b)=>a-b),
    lookupErrorIssues:lookupErrorIssues.sort((a,b)=>a-b),
    activeSessionIds,
  };
}

function parseArgs(argv:string[]){
  const out:Record<string,string>={};
  for(let i=0;i<argv.length;i+=2){
    const key=argv[i],value=argv[i+1];
    if(!key||!['--state-root','--repository','--author','--gh-path'].includes(key)||value===undefined
      ||Object.hasOwn(out,key.slice(2)))fail('RBRIDGE_DURABLE_AUDIT_ARGS_INVALID');
    out[key.slice(2)]=value;
  }
  if(!out['state-root']||!out.repository||!out.author)fail('RBRIDGE_DURABLE_AUDIT_ARGS_INVALID');
  return {stateRoot:out['state-root'],repository:out.repository,author:out.author,ghPath:out['gh-path']};
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  const lookup=await createGitHubIssueLookup({repository:args.repository,...(args.ghPath?{ghPath:args.ghPath}:{})});
  const summary=await auditRemoteBridgeDurableState({stateRoot:args.stateRoot,expectedAuthor:args.author,issueLookup:lookup});
  console.log(JSON.stringify(summary,null,2));
  if(summary.auditStatus==='UNKNOWN')process.exitCode=3;
  else if(summary.cutoverGate==='BLOCKED')process.exitCode=4;
}

const invoked=process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url;
if(invoked)main().catch(error=>{
  const reason=error instanceof Error&&/^RBRIDGE_DURABLE_AUDIT_[A-Z_]+$/.test(error.message)?error.message:'RBRIDGE_DURABLE_AUDIT_EVIDENCE_UNREADABLE';
  console.log(JSON.stringify({schema:'RBRIDGE_DURABLE_STATE_AUDIT_V1',auditStatus:'UNKNOWN',cutoverGate:'UNKNOWN',reason}));
  process.exitCode=2;
});
