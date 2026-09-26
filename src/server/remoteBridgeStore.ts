import {chmod,mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

export type RemoteBridgeStorePhase='CLAIMED'|'SUBMITTED'|'TERMINAL'|'PUBLISHED';
export interface RemoteBridgeStoreRecord {schema:'COCWIN_REMOTE_BRIDGE_STORE_V1';requestId:string;requestSha256:string;issueNumber:number;jobId:string;phase:RemoteBridgeStorePhase;createdAt:string;updatedAt:string;result?:unknown;}
export interface RemoteBridgeClaimInput {requestId:string;requestSha256:string;issueNumber:number;jobId:string;}
const ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;const JOB_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;const SHA_RE=/^[0-9a-f]{64}$/;
function fail(code:string):never{throw new Error(code);}
async function ensureRoot(root:string){await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);}
function pathFor(root:string,id:string){if(!ID_RE.test(id))fail('REMOTE_BRIDGE_STORE_REQUEST_ID_INVALID');return join(root,`${id}.json`);}
function validate(row:unknown):RemoteBridgeStoreRecord{if(!row||typeof row!=='object'||Array.isArray(row))fail('REMOTE_BRIDGE_STORE_CORRUPT');const r=row as Record<string,unknown>;if(r.schema!=='COCWIN_REMOTE_BRIDGE_STORE_V1'||typeof r.requestId!=='string'||!ID_RE.test(r.requestId)||typeof r.requestSha256!=='string'||!SHA_RE.test(r.requestSha256)||!Number.isSafeInteger(r.issueNumber)||Number(r.issueNumber)<1||typeof r.jobId!=='string'||!JOB_RE.test(r.jobId)||!['CLAIMED','SUBMITTED','TERMINAL','PUBLISHED'].includes(String(r.phase))||typeof r.createdAt!=='string'||typeof r.updatedAt!=='string')fail('REMOTE_BRIDGE_STORE_CORRUPT');return r as unknown as RemoteBridgeStoreRecord;}
async function read(root:string,id:string):Promise<RemoteBridgeStoreRecord|undefined>{try{return validate(JSON.parse(await readFile(pathFor(root,id),'utf8')));}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return undefined;throw error;}}
async function atomicWrite(root:string,record:RemoteBridgeStoreRecord):Promise<void>{await ensureRoot(root);const final=pathFor(root,record.requestId);const temp=`${final}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;const h=await open(temp,'wx',0o600);try{await h.writeFile(`${JSON.stringify(record)}\n`,'utf8');await h.sync();}finally{await h.close();}try{await rename(temp,final);await chmod(final,0o600);const d=await open(root,'r');try{await d.sync();}finally{await d.close();}}catch(error){await unlink(temp).catch(()=>undefined);throw error;}}
function digestGuard(record:RemoteBridgeStoreRecord,digest:string){if(record.requestSha256!==digest)fail('REMOTE_BRIDGE_STORE_DIGEST_MISMATCH');}

export function createRemoteBridgeStore(root:string,now:()=>Date=()=>new Date()){
  async function transition(id:string,digest:string,allowed:RemoteBridgeStorePhase[],phase:RemoteBridgeStorePhase,result?:unknown){const current=await read(root,id);if(!current)fail('REMOTE_BRIDGE_STORE_MISSING');digestGuard(current,digest);if(!allowed.includes(current.phase))fail('REMOTE_BRIDGE_STORE_PHASE_INVALID');const next:RemoteBridgeStoreRecord={...current,phase,updatedAt:now().toISOString(),...(result===undefined?{}:{result})};await atomicWrite(root,next);return next;}
  return {
    async get(requestId:string){await ensureRoot(root);return await read(root,requestId);},
    async claim(input:RemoteBridgeClaimInput){if(!ID_RE.test(input.requestId)||!SHA_RE.test(input.requestSha256)||!Number.isSafeInteger(input.issueNumber)||input.issueNumber<1||!JOB_RE.test(input.jobId))fail('REMOTE_BRIDGE_STORE_CLAIM_INVALID');await ensureRoot(root);const existing=await read(root,input.requestId);if(existing)return existing.requestSha256===input.requestSha256?{state:'REPLAY' as const,record:existing}:{state:'COLLISION' as const,record:existing};const stamp=now().toISOString();const record:RemoteBridgeStoreRecord={schema:'COCWIN_REMOTE_BRIDGE_STORE_V1',...input,phase:'CLAIMED',createdAt:stamp,updatedAt:stamp};await atomicWrite(root,record);return {state:'CLAIMED' as const,record};},
    async markSubmitted(id:string,digest:string){return await transition(id,digest,['CLAIMED'],'SUBMITTED');},
    async markTerminal(id:string,digest:string,result:unknown){return await transition(id,digest,['CLAIMED','SUBMITTED'],'TERMINAL',result);},
    async markPublished(id:string,digest:string){return await transition(id,digest,['TERMINAL'],'PUBLISHED');},
  };
}

async function pidAlive(pid:number){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException)?.code==='EPERM';}}
export async function acquireRemoteBridgeProcessLock(root:string){await ensureRoot(root);const path=join(root,'relay.lock');for(let attempt=0;attempt<2;attempt++){try{const h=await open(path,'wx',0o600);await h.writeFile(`${process.pid}\n`,'utf8');await h.sync();let released=false;return {async release(){if(released)return;released=true;await h.close();await unlink(path).catch(()=>undefined);}};}catch(error){if((error as NodeJS.ErrnoException)?.code!=='EEXIST')throw error;let stale=false;try{const pid=Number((await readFile(path,'utf8')).trim());stale=!(await pidAlive(pid));}catch{stale=true;}if(stale&&attempt===0){await unlink(path).catch(()=>undefined);continue;}fail('REMOTE_BRIDGE_PROCESS_LOCKED');}}fail('REMOTE_BRIDGE_PROCESS_LOCKED');}