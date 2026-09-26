import {createHash} from 'node:crypto';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {
  appendFileSync,chmodSync,existsSync,mkdirSync,readFileSync,readlinkSync,renameSync,
  rmSync,statSync,writeFileSync
} from 'node:fs';
import {userInfo} from 'node:os';
import {createServer,type Server,type Socket} from 'node:net';

export type RemoteBridgeProcessIdentity={
  pid:number;
  startTimeTicks:string;
  exe:string;
  cmdlineSha256:string;
};
export type RemoteBridgeProcessSessionState='STARTING'|'RUNNING'|'TERMINATING'|'SUCCEEDED'|'FAILED'|'TERMINATED'|'UNCERTAIN';
export type RemoteBridgeProcessSupervisorSpec={
  schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_V1';
  sessionId:string;
  ownerDigest:string;
  profileId:string;
  executable:string;
  args:string[];
  cwd:string;
  createdAt:string;
  expiresAt:string;
  maxOutputBytes:number;
  stdinMode:'DENY'|'UTF8';
  maxInputBytes:number;
  forceKillAfterMs:number|null;
  sessionDir:string;
  recordPath:string;
  outputPath:string;
  socketPath:string;
};
export type RemoteBridgeProcessSessionRecord={
  schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1';
  sessionId:string;
  ownerDigest:string;
  profileId:string;
  state:RemoteBridgeProcessSessionState;
  createdAt:string;
  updatedAt:string;
  expiresAt:string;
  pid:number|null;
  identity:RemoteBridgeProcessIdentity|null;
  outputBytes:number;
  truncated:boolean;
  stdinAttached:boolean;
  exitCode:number|null;
  signal:string|null;
  reason:string|null;
  receipts:Record<string,'CLAIMED'|'DONE'|'UNCERTAIN'>;
};

const SESSION_RE=/^[a-f0-9]{32}$/;
const DIGEST_RE=/^[a-f0-9]{64}$/;
const ACTION_RE=/^[a-f0-9]{64}$/;
const TERMINAL=new Set<RemoteBridgeProcessSessionState>(['SUCCEEDED','FAILED','TERMINATED','UNCERTAIN']);
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();

function fail(code:string):never{throw new Error(code);}
function atomicJson(path:string,value:unknown):void{
  const temp=`${path}.tmp-${process.pid}`;
  writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600});
  renameSync(temp,path);
  chmodSync(path,0o600);
}
function loadSpec(path:string):RemoteBridgeProcessSupervisorSpec{
  const value=JSON.parse(readFileSync(path,'utf8')) as Partial<RemoteBridgeProcessSupervisorSpec>;
  if(value.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_V1'||typeof value.sessionId!=='string'||!SESSION_RE.test(value.sessionId)
    ||typeof value.ownerDigest!=='string'||!DIGEST_RE.test(value.ownerDigest)||typeof value.profileId!=='string'
    ||typeof value.executable!=='string'||!value.executable.startsWith('/')||!Array.isArray(value.args)
    ||value.args.some(item=>typeof item!=='string'||item.includes('\0'))||typeof value.cwd!=='string'||!value.cwd.startsWith('/')
    ||typeof value.createdAt!=='string'||typeof value.expiresAt!=='string'||typeof value.maxOutputBytes!=='number'
    ||!Number.isInteger(value.maxOutputBytes)||value.maxOutputBytes<4096||value.maxOutputBytes>1_048_576
    ||(value.stdinMode!=='DENY'&&value.stdinMode!=='UTF8')||typeof value.maxInputBytes!=='number'||!Number.isInteger(value.maxInputBytes)
    ||typeof value.sessionDir!=='string'||typeof value.recordPath!=='string'||typeof value.outputPath!=='string'||typeof value.socketPath!=='string'){
    fail('REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_INVALID');
  }
  const force=value.forceKillAfterMs;
  if(force!==null&&(typeof force!=='number'||!Number.isInteger(force)||force<100||force>10_000))fail('REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_INVALID');
  return value as RemoteBridgeProcessSupervisorSpec;
}
export function captureRemoteBridgeProcessIdentity(pid:number):RemoteBridgeProcessIdentity{
  if(!Number.isInteger(pid)||pid<=1)fail('REMOTE_BRIDGE_PROCESS_PID_INVALID');
  const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
  const close=stat.lastIndexOf(')');
  if(close<0)fail('REMOTE_BRIDGE_PROCESS_STAT_INVALID');
  const fields=stat.slice(close+2).trim().split(/\s+/);
  const start=fields[19];
  if(!start||!/^\d+$/.test(start))fail('REMOTE_BRIDGE_PROCESS_STAT_INVALID');
  const cmdline=readFileSync(`/proc/${pid}/cmdline`);
  if(cmdline.length===0)fail('REMOTE_BRIDGE_PROCESS_CMDLINE_INVALID');
  return {pid,startTimeTicks:start,exe:readlinkSync(`/proc/${pid}/exe`),cmdlineSha256:sha(cmdline)};
}
export function sameRemoteBridgeProcessIdentity(expected:RemoteBridgeProcessIdentity,actual:RemoteBridgeProcessIdentity):boolean{
  return expected.pid===actual.pid&&expected.startTimeTicks===actual.startTimeTicks&&expected.exe===actual.exe&&expected.cmdlineSha256===actual.cmdlineSha256;
}
async function waitIdentity(pid:number):Promise<RemoteBridgeProcessIdentity>{
  let last:unknown;
  for(let attempt=0;attempt<50;attempt++){
    try{return captureRemoteBridgeProcessIdentity(pid);}catch(error){last=error;await new Promise(resolve=>setTimeout(resolve,10));}
  }
  throw last instanceof Error?last:new Error('REMOTE_BRIDGE_PROCESS_IDENTITY_UNAVAILABLE');
}
function sanitizedEnvironment():NodeJS.ProcessEnv{
  const user=userInfo();
  return {
    HOME:user.homedir,USER:user.username,LOGNAME:user.username,
    PATH:'/opt/ai-tool-fabric/runtime:/usr/local/bin:/usr/bin:/bin',
    LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:'/tmp',NO_COLOR:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'
  };
}
function publicRecord(record:RemoteBridgeProcessSessionRecord){
  return {
    schema:record.schema,sessionId:record.sessionId,profileId:record.profileId,state:record.state,
    createdAt:record.createdAt,updatedAt:record.updatedAt,expiresAt:record.expiresAt,pid:record.pid,
    outputBytes:record.outputBytes,truncated:record.truncated,stdinAttached:record.stdinAttached,
    exitCode:record.exitCode,signal:record.signal,reason:record.reason
  };
}
function parseCommand(raw:string):Record<string,unknown>{
  let value:unknown;
  try{value=JSON.parse(raw);}catch{fail('REMOTE_BRIDGE_PROCESS_COMMAND_JSON_INVALID');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail('REMOTE_BRIDGE_PROCESS_COMMAND_INVALID');
  return value as Record<string,unknown>;
}

export async function runRemoteBridgeProcessSupervisor(specPath:string):Promise<void>{
  const spec=loadSpec(specPath);
  mkdirSync(spec.sessionDir,{recursive:true,mode:0o700});chmodSync(spec.sessionDir,0o700);
  const info=statSync(spec.sessionDir);if(!info.isDirectory()||(info.mode&0o077)!==0)fail('REMOTE_BRIDGE_PROCESS_STATE_PERMISSIONS_INVALID');
  writeFileSync(spec.outputPath,'',{mode:0o600});chmodSync(spec.outputPath,0o600);
  if(existsSync(spec.socketPath))rmSync(spec.socketPath,{force:true});
  let child:ChildProcessWithoutNullStreams|null=null;
  let server:Server|null=null;
  let stopReason:string|null=null;
  let stopping=false;
  let outputLimitTriggered=false;
  const record:RemoteBridgeProcessSessionRecord={
    schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1',sessionId:spec.sessionId,ownerDigest:spec.ownerDigest,
    profileId:spec.profileId,state:'STARTING',createdAt:spec.createdAt,updatedAt:now(),expiresAt:spec.expiresAt,
    pid:null,identity:null,outputBytes:0,truncated:false,stdinAttached:false,exitCode:null,signal:null,reason:null,receipts:{}
  };
  const persist=()=>{record.updatedAt=now();atomicJson(spec.recordPath,record);};
  persist();

  const identityIsCurrent=():boolean=>{
    if(!record.identity||!record.pid)return false;
    try{return sameRemoteBridgeProcessIdentity(record.identity,captureRemoteBridgeProcessIdentity(record.pid));}catch{return false;}
  };
  const signalChild=(signal:NodeJS.Signals):boolean=>{
    if(!record.pid||!record.identity||!identityIsCurrent()){
      record.state='UNCERTAIN';record.reason='REMOTE_BRIDGE_PROCESS_IDENTITY_UNCERTAIN';persist();return false;
    }
    try{process.kill(-record.pid,signal);return true;}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==='ESRCH')return true;
      record.state='UNCERTAIN';record.reason='REMOTE_BRIDGE_PROCESS_SIGNAL_FAILED';persist();return false;
    }
  };
  const requestStop=(reason:string):void=>{
    if(stopping||TERMINAL.has(record.state))return;
    stopping=true;stopReason=reason;record.reason=reason;record.state='TERMINATING';persist();
    if(!signalChild('SIGTERM'))return;
    if(spec.forceKillAfterMs!==null){
      setTimeout(()=>{if(child&&!TERMINAL.has(record.state)&&identityIsCurrent())signalChild('SIGKILL');},spec.forceKillAfterMs).unref();
    }
  };
  const appendEvent=(stream:'stdout'|'stderr',data:Buffer):void=>{
    if(data.length===0||TERMINAL.has(record.state))return;
    let offset=0;
    while(offset<data.length){
      const remaining=spec.maxOutputBytes-record.outputBytes;
      if(remaining<=0){record.truncated=true;outputLimitTriggered=true;requestStop('REMOTE_BRIDGE_PROCESS_OUTPUT_LIMIT');return;}
      const take=Math.min(4096,data.length-offset,remaining);
      const piece=data.subarray(offset,offset+take);
      const line=JSON.stringify({stream,dataBase64:piece.toString('base64')})+'\n';
      appendFileSync(spec.outputPath,line,{encoding:'utf8',mode:0o600});
      record.outputBytes+=piece.length;offset+=take;
      if(offset<data.length&&record.outputBytes>=spec.maxOutputBytes){
        record.truncated=true;outputLimitTriggered=true;persist();requestStop('REMOTE_BRIDGE_PROCESS_OUTPUT_LIMIT');return;
      }
    }
    persist();
  };

  const handleCommand=async(socket:Socket,row:Record<string,unknown>):Promise<void>=>{
    if(row.sessionId!==spec.sessionId||row.ownerDigest!==spec.ownerDigest)fail('REMOTE_BRIDGE_PROCESS_SESSION_OWNER_MISMATCH');
    const action=row.action;
    if(action==='STATUS'){socket.end(JSON.stringify({status:'PASS',result:publicRecord(record)})+'\n');return;}
    if(action==='WRITE_INPUT'){
      if(spec.stdinMode!=='UTF8')fail('REMOTE_BRIDGE_PROCESS_STDIN_NOT_ALLOWED');
      if(record.state!=='RUNNING'||!child||!record.stdinAttached)fail('REMOTE_BRIDGE_PROCESS_NOT_RUNNING');
      const actionId=row.actionId,data=row.data;
      if(typeof actionId!=='string'||!ACTION_RE.test(actionId)||typeof data!=='string'||data.includes('\0')||Buffer.byteLength(data)>spec.maxInputBytes)fail('REMOTE_BRIDGE_PROCESS_INPUT_INVALID');
      const prior=record.receipts[actionId];
      if(prior==='DONE'){socket.end(JSON.stringify({status:'PASS',result:{action:'WRITE_INPUT',replay:true}})+'\n');return;}
      if(prior)fail('REMOTE_BRIDGE_PROCESS_ACTION_UNCERTAIN');
      record.receipts[actionId]='CLAIMED';persist();
      try{
        await new Promise<void>((resolve,reject)=>{child!.stdin.write(data,'utf8',error=>error?reject(error):resolve());});
        record.receipts[actionId]='DONE';persist();
        socket.end(JSON.stringify({status:'PASS',result:{action:'WRITE_INPUT',bytes:Buffer.byteLength(data),replay:false}})+'\n');
      }catch{
        record.receipts[actionId]='UNCERTAIN';persist();fail('REMOTE_BRIDGE_PROCESS_INPUT_WRITE_UNCERTAIN');
      }
      return;
    }
    if(action==='TERMINATE'){
      const actionId=row.actionId;
      if(typeof actionId!=='string'||!ACTION_RE.test(actionId))fail('REMOTE_BRIDGE_PROCESS_ACTION_ID_INVALID');
      if(TERMINAL.has(record.state)){socket.end(JSON.stringify({status:'PASS',result:publicRecord(record)})+'\n');return;}
      const prior=record.receipts[actionId];
      if(prior==='DONE'){socket.end(JSON.stringify({status:'PASS',result:{action:'TERMINATE',replay:true}})+'\n');return;}
      if(prior)fail('REMOTE_BRIDGE_PROCESS_ACTION_UNCERTAIN');
      record.receipts[actionId]='CLAIMED';persist();
      requestStop('REMOTE_BRIDGE_PROCESS_TERMINATED_BY_REQUEST');
      if(record.state==='UNCERTAIN'){record.receipts[actionId]='UNCERTAIN';persist();fail('REMOTE_BRIDGE_PROCESS_TERMINATE_UNCERTAIN');}
      record.receipts[actionId]='DONE';persist();
      socket.end(JSON.stringify({status:'PASS',result:{action:'TERMINATE',replay:false}})+'\n');return;
    }
    fail('REMOTE_BRIDGE_PROCESS_COMMAND_ACTION_INVALID');
  };

  server=createServer(socket=>{
    socket.setEncoding('utf8');let text='';let handled=false;
    const finishError=(error:unknown)=>{if(handled)return;handled=true;const reason=error instanceof Error?error.message:'REMOTE_BRIDGE_PROCESS_COMMAND_FAILED';socket.end(JSON.stringify({status:'BLOCKED',reason})+'\n');};
    socket.on('data',chunk=>{
      if(handled)return;text+=chunk;
      if(Buffer.byteLength(text)>spec.maxInputBytes+16_384){finishError(new Error('REMOTE_BRIDGE_PROCESS_COMMAND_TOO_LARGE'));return;}
      const newline=text.indexOf('\n');if(newline<0)return;
      handled=true;
      Promise.resolve(handleCommand(socket,parseCommand(text.slice(0,newline)))).catch(error=>{handled=false;finishError(error);});
    });
    socket.on('error',()=>{});
  });
  try{
    await new Promise<void>((resolve,reject)=>{
      const current=server!;current.once('error',reject);current.listen(spec.socketPath,()=>{current.off('error',reject);resolve();});
    });
    chmodSync(spec.socketPath,0o600);
    if(Date.now()-Date.parse(spec.createdAt)>3_000)fail('REMOTE_BRIDGE_PROCESS_START_DEADLINE_EXPIRED');
    child=spawn(spec.executable,[...spec.args],{cwd:spec.cwd,shell:false,detached:true,stdio:['pipe','pipe','pipe'],env:sanitizedEnvironment()});
    child.stdin.on('error',()=>{});
    if(!child.pid)fail('REMOTE_BRIDGE_PROCESS_SPAWN_PID_MISSING');
    child.stdout.on('data',(chunk:Buffer)=>appendEvent('stdout',chunk));
    child.stderr.on('data',(chunk:Buffer)=>appendEvent('stderr',chunk));
    const completion=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
      child!.once('close',(code,signal)=>resolve({code,signal}));
    });
    record.pid=child.pid;
    let completedEarly:{code:number|null;signal:NodeJS.Signals|null}|null=null;
    try{
      record.identity=await waitIdentity(child.pid);
    }catch{
      const observed=await Promise.race([
        completion.then(value=>({settled:true as const,value})),
        new Promise<{settled:false}>(resolve=>setTimeout(()=>resolve({settled:false}),25))
      ]);
      if(observed.settled)completedEarly=observed.value;
      else{record.state='UNCERTAIN';record.reason='REMOTE_BRIDGE_PROCESS_IDENTITY_UNCERTAIN';record.stdinAttached=false;persist();}
    }
    if(record.identity){
      record.state='RUNNING';record.stdinAttached=spec.stdinMode==='UTF8';persist();
      const lifetime=Math.max(1,Date.parse(spec.expiresAt)-Date.now());
      setTimeout(()=>requestStop('REMOTE_BRIDGE_PROCESS_TIMEOUT'),lifetime).unref();
    }
    const completed=completedEarly??await completion;
    record.stdinAttached=false;record.exitCode=completed.code;record.signal=completed.signal;
    if((record.state as RemoteBridgeProcessSessionState)!=='UNCERTAIN'){
      if(stopReason==='REMOTE_BRIDGE_PROCESS_TERMINATED_BY_REQUEST')record.state='TERMINATED';
      else if(stopReason==='REMOTE_BRIDGE_PROCESS_TIMEOUT'||outputLimitTriggered)record.state='FAILED';
      else record.state=completed.code===0?'SUCCEEDED':'FAILED';
    }
    persist();
  }catch(error){
    if(record.state!=='UNCERTAIN'){
      record.state='FAILED';record.stdinAttached=false;record.reason=error instanceof Error?error.message:'REMOTE_BRIDGE_PROCESS_SUPERVISOR_FAILED';persist();
    }
  }finally{
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    if(existsSync(spec.socketPath))rmSync(spec.socketPath,{force:true});
  }
}

const direct=process.argv[1]?.endsWith('/remoteBridgeProcessSupervisor.js');
if(direct){
  const specPath=process.argv[2];
  if(!specPath)throw new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_REQUIRED');
  runRemoteBridgeProcessSupervisor(specPath).catch(error=>{
    console.error(error instanceof Error?error.message:'REMOTE_BRIDGE_PROCESS_SUPERVISOR_FAILED');process.exitCode=1;
  });
}
