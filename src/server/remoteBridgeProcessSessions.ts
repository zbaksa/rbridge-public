import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  chmod,mkdir,readFile,readdir,realpath,rename,stat,writeFile
} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConnection} from 'node:net';
import {
  resolveRemoteBridgeProcessCommandProfile,type RemoteBridgeResolvedProcessProfile
} from '../domain/remoteBridgeHostProfiles.js';
import type {RemoteBridgeStage2Operation} from '../domain/remoteBridgeStage2Protocol.js';
import {
  captureRemoteBridgeProcessIdentity,sameRemoteBridgeProcessIdentity,
  type RemoteBridgeProcessSessionRecord,type RemoteBridgeProcessSupervisorSpec
} from './remoteBridgeProcessSupervisor.js';

type ProcessOperation=Extract<RemoteBridgeStage2Operation,{kind:'PROCESS'}>;
type ProfileResolver=(profileId:string,argv:unknown)=>RemoteBridgeResolvedProcessProfile;
type LaunchSupervisor=(specPath:string,sessionId:string)=>Promise<void>|void;
export interface RemoteBridgeProcessSessionsConfig{
  root:string;
  now?:()=>Date;
  resolveProfile?:ProfileResolver;
  launchSupervisor?:LaunchSupervisor;
  supervisorPath?:string;
}
const SESSION_RE=/^[a-f0-9]{32}$/;
const DIGEST_RE=/^[a-f0-9]{64}$/;
const TERMINAL=new Set(['SUCCEEDED','FAILED','TERMINATED','UNCERTAIN']);
const START_CLAIM_SCHEMA='COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1';
type StartClaim={schema:typeof START_CLAIM_SCHEMA;ownerDigest:string;sessionId:string;profileId:string;createdAt:string;};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fail(code:string):never{throw new Error(code);}
function row(value:unknown,code:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]):void{
  const allowed=new Set([...required,...optional]);
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.has(key)))fail('REMOTE_BRIDGE_PROCESS_ARGS_FIELDS_INVALID');
}
function digest(value:unknown):string{
  if(typeof value!=='string'||!DIGEST_RE.test(value))fail('REMOTE_BRIDGE_PROCESS_OWNER_DIGEST_INVALID');
  return value;
}
function sessionId(value:unknown):string{
  if(typeof value!=='string'||!SESSION_RE.test(value))fail('REMOTE_BRIDGE_PROCESS_SESSION_ID_INVALID');
  return value;
}
function safePublic(record:RemoteBridgeProcessSessionRecord){
  return {
    schema:record.schema,sessionId:record.sessionId,profileId:record.profileId,state:record.state,
    createdAt:record.createdAt,updatedAt:record.updatedAt,expiresAt:record.expiresAt,pid:record.pid,
    outputBytes:record.outputBytes,truncated:record.truncated,stdinAttached:record.stdinAttached,
    exitCode:record.exitCode,signal:record.signal,reason:record.reason
  };
}
async function atomicJson(path:string,value:unknown):Promise<void>{
  const temp=`${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600});
  await rename(temp,path);await chmod(path,0o600);
}
function safeSupervisorEnvironment():NodeJS.ProcessEnv{
  const user=userInfo(),uid=user.uid;
  if(!Number.isInteger(uid)||uid<0)fail('REMOTE_BRIDGE_PROCESS_USER_MANAGER_UNAVAILABLE');
  return {
    HOME:user.homedir,USER:user.username,LOGNAME:user.username,
    PATH:'/opt/ai-tool-fabric/runtime:/usr/local/bin:/usr/bin:/bin',
    LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:'/tmp',NO_COLOR:'1',
    XDG_RUNTIME_DIR:`/run/user/${uid}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${uid}/bus`
  };
}
export interface RemoteBridgeSupervisorLaunch{  command:'/usr/bin/systemd-run';
  args:string[];
  options:{shell:false;detached:false;stdio:['ignore','ignore','pipe'];env:NodeJS.ProcessEnv};
}
export function buildRemoteBridgeSupervisorLaunch(
  supervisorPath:string,specPath:string,id:string,env:NodeJS.ProcessEnv
):RemoteBridgeSupervisorLaunch{
  sessionId(id);
  if(!supervisorPath.startsWith('/')||!specPath.startsWith('/')||supervisorPath.includes('\0')||specPath.includes('\0'))fail('REMOTE_BRIDGE_PROCESS_SUPERVISOR_PATH_INVALID');
  const environmentKeys=['HOME','USER','LOGNAME','PATH','LANG','LC_ALL','TMPDIR','NO_COLOR','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'] as const;
  for(const key of environmentKeys){
    const value=env[key];
    if(typeof value!=='string'||value.length===0||value.includes('\0')||value.includes('\n')||value.includes('\r'))fail('REMOTE_BRIDGE_PROCESS_SUPERVISOR_ENV_INVALID');
  }
  const args=[
    '--user','--quiet','--collect',
    `--unit=cocwin-remote-bridge-process-${id}.service`,
    '--property=KillMode=control-group','--property=UMask=0077',
    ...environmentKeys.map(key=>`--setenv=${key}=${env[key]}`),
    '/opt/ai-tool-fabric/runtime/node',supervisorPath,specPath
  ];
  return {command:'/usr/bin/systemd-run',args,options:{shell:false,detached:false,stdio:['ignore','ignore','pipe'],env}};
}
async function launchRemoteBridgeSupervisor(
  supervisorPath:string,specPath:string,id:string
):Promise<void>{
  const launch=buildRemoteBridgeSupervisorLaunch(supervisorPath,specPath,id,safeSupervisorEnvironment());
  await new Promise<void>((resolvePromise,rejectPromise)=>{
    const child=spawn(launch.command,launch.args,launch.options);
    let stderrBytes=0;    child.stderr?.on('data',(chunk:Buffer|string)=>{
      stderrBytes+=Buffer.byteLength(chunk);
      if(stderrBytes>4096)child.stderr?.destroy();
    });
    child.once('error',()=>rejectPromise(new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_LAUNCH_FAILED')));
    child.once('close',code=>{
      if(code===0)resolvePromise();
      else rejectPromise(new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_LAUNCH_FAILED'));
    });
  });
}

export function createRemoteBridgeProcessSessions(config:RemoteBridgeProcessSessionsConfig){
  const clock=config.now??(()=>new Date());
  const resolver=config.resolveProfile??resolveRemoteBridgeProcessCommandProfile;
  const supervisorPath=config.supervisorPath??fileURLToPath(new URL('./remoteBridgeProcessSupervisor.js',import.meta.url));
  const launch=config.launchSupervisor??((specPath:string,id:string)=>launchRemoteBridgeSupervisor(supervisorPath,specPath,id));
  const root=config.root,claimsRoot=join(root,'start-claims');
  const claimPath=(ownerDigest:string)=>join(claimsRoot,ownerDigest+'.json');
  async function ensureRoot():Promise<void>{
    if(!root.startsWith('/')||resolve(root)!==root)fail('REMOTE_BRIDGE_PROCESS_STATE_ROOT_INVALID');
    await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
    const info=await stat(root);if(!info.isDirectory()||(info.mode&0o077)!==0)fail('REMOTE_BRIDGE_PROCESS_STATE_ROOT_INVALID');
    await mkdir(claimsRoot,{recursive:true,mode:0o700});await chmod(claimsRoot,0o700);
    const claimInfo=await stat(claimsRoot);if(!claimInfo.isDirectory()||(claimInfo.mode&0o077)!==0)fail('REMOTE_BRIDGE_PROCESS_START_CLAIM_ROOT_INVALID');
  }
  const paths=(id:string)=>{
    const dir=join(root,id);
    const value={dir,spec:join(dir,'spec.json'),record:join(dir,'record.json'),output:join(dir,'output.ndjson'),socket:join(dir,'control.sock')};
    if(Buffer.byteLength(value.socket)>100)fail('REMOTE_BRIDGE_PROCESS_SOCKET_PATH_TOO_LONG');
    return value;
  };
  async function loadRecord(id:string):Promise<RemoteBridgeProcessSessionRecord>{
    sessionId(id);
    let parsed:unknown;
    try{parsed=JSON.parse(await readFile(paths(id).record,'utf8'));}catch{fail('REMOTE_BRIDGE_PROCESS_SESSION_NOT_FOUND');}
    const value=row(parsed,'REMOTE_BRIDGE_PROCESS_SESSION_RECORD_INVALID');
    if(value.schema!=='COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1'||value.sessionId!==id||typeof value.ownerDigest!=='string'||!DIGEST_RE.test(value.ownerDigest))fail('REMOTE_BRIDGE_PROCESS_SESSION_RECORD_INVALID');
    return value as unknown as RemoteBridgeProcessSessionRecord;
  }
  function assertOwner(record:RemoteBridgeProcessSessionRecord,ownerDigest:string):void{
    if(record.ownerDigest!==digest(ownerDigest))fail('REMOTE_BRIDGE_PROCESS_SESSION_OWNER_MISMATCH');
  }
  async function allowedCwd(requested:unknown,profile:RemoteBridgeResolvedProcessProfile):Promise<string>{
    if(typeof requested!=='string'||!requested.startsWith('/')||requested.includes('\0')||resolve(requested)!==requested)fail('REMOTE_BRIDGE_PROCESS_CWD_INVALID');
    let actual:string;
    try{actual=await realpath(requested);}catch{fail('REMOTE_BRIDGE_PROCESS_CWD_INVALID');}
    if(actual!==requested)fail('REMOTE_BRIDGE_PROCESS_CWD_SYMLINK_FORBIDDEN');
    let accepted=false;
    for(const sourceRoot of profile.cwdRoots){
      let allowed:string;
      try{allowed=await realpath(sourceRoot);}catch{continue;}
      if(actual===allowed||actual.startsWith(allowed+sep)){accepted=true;break;}
    }
    if(!accepted)fail('REMOTE_BRIDGE_PROCESS_CWD_NOT_ALLOWED');
    return actual;
  }
  async function sendCommand(id:string,command:Record<string,unknown>):Promise<unknown>{
    const socketPath=paths(id).socket;
    let last:unknown;
    for(let attempt=0;attempt<2;attempt++){
      try{
        return await new Promise<unknown>((resolvePromise,rejectPromise)=>{
          const socket=createConnection(socketPath);
          const timer=setTimeout(()=>{socket.destroy();rejectPromise(new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_TIMEOUT'));},2_000);
          let text='';
          const done=(error?:Error,value?:unknown)=>{clearTimeout(timer);socket.destroy();if(error)rejectPromise(error);else resolvePromise(value);};
          socket.setEncoding('utf8');
          socket.once('connect',()=>socket.write(JSON.stringify(command)+'\n'));
          socket.on('data',chunk=>{
            text+=chunk;if(Buffer.byteLength(text)>131_072){done(new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_RESPONSE_TOO_LARGE'));return;}
            const newline=text.indexOf('\n');if(newline<0)return;
            let parsed:unknown;try{parsed=JSON.parse(text.slice(0,newline));}catch{done(new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_RESPONSE_INVALID'));return;}
            const response=row(parsed,'REMOTE_BRIDGE_PROCESS_SUPERVISOR_RESPONSE_INVALID');
            if(response.status!=='PASS'){done(new Error(typeof response.reason==='string'?response.reason:'REMOTE_BRIDGE_PROCESS_SUPERVISOR_BLOCKED'));return;}
            done(undefined,response.result);
          });
          socket.once('error',error=>done(error));
        });
      }catch(error){last=error;if(attempt===0)await delay(50);}
    }
    if(last instanceof Error&&last.message.startsWith('REMOTE_BRIDGE_PROCESS_'))throw last;
    throw new Error('REMOTE_BRIDGE_PROCESS_SUPERVISOR_UNREACHABLE');
  }
  async function markUncertain(record:RemoteBridgeProcessSessionRecord,reason:string):Promise<RemoteBridgeProcessSessionRecord>{
    if(TERMINAL.has(record.state))return record;
    record.state='UNCERTAIN';record.reason=reason;record.stdinAttached=false;record.updatedAt=clock().toISOString();
    await atomicJson(paths(record.sessionId).record,record);return record;
  }
  async function reconcile(record:RemoteBridgeProcessSessionRecord):Promise<RemoteBridgeProcessSessionRecord>{
    if(TERMINAL.has(record.state))return record;
    try{
      const result=await sendCommand(record.sessionId,{action:'STATUS',sessionId:record.sessionId,ownerDigest:record.ownerDigest});
      return {...record,...row(result,'REMOTE_BRIDGE_PROCESS_STATUS_INVALID')} as RemoteBridgeProcessSessionRecord;
    }catch{
      let fallbackRecord=record;
      try{const refreshed=await loadRecord(record.sessionId);if(TERMINAL.has(refreshed.state))return refreshed;fallbackRecord=refreshed;}catch{}
      if(!fallbackRecord.pid||!fallbackRecord.identity)return await markUncertain(fallbackRecord,'REMOTE_BRIDGE_PROCESS_IDENTITY_UNPROVEN');
      try{
        const current=captureRemoteBridgeProcessIdentity(fallbackRecord.pid);
        if(!sameRemoteBridgeProcessIdentity(fallbackRecord.identity,current))return await markUncertain(fallbackRecord,'REMOTE_BRIDGE_PROCESS_IDENTITY_MISMATCH');
        return await markUncertain(fallbackRecord,'REMOTE_BRIDGE_PROCESS_SUPERVISOR_UNREACHABLE');
      }catch{return await markUncertain(fallbackRecord,'REMOTE_BRIDGE_PROCESS_EXIT_UNOBSERVED');}
    }
  }
  async function existingForOwner(ownerDigest:string):Promise<RemoteBridgeProcessSessionRecord|null>{
    await ensureRoot();
    for(const entry of await readdir(root,{withFileTypes:true})){
      if(!entry.isDirectory()||!SESSION_RE.test(entry.name))continue;
      try{const record=await loadRecord(entry.name);if(record.ownerDigest===ownerDigest)return record;}catch{}
    }
    return null;
  }
  async function loadStartClaim(ownerDigest:string):Promise<StartClaim|null>{
    digest(ownerDigest);
    let parsed:unknown;
    try{parsed=JSON.parse(await readFile(claimPath(ownerDigest),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;fail('REMOTE_BRIDGE_PROCESS_START_CLAIM_INVALID');}
    const value=row(parsed,'REMOTE_BRIDGE_PROCESS_START_CLAIM_INVALID');
    if(value.schema!==START_CLAIM_SCHEMA||value.ownerDigest!==ownerDigest||typeof value.sessionId!=='string'||!SESSION_RE.test(value.sessionId)
      ||typeof value.profileId!=='string'||value.profileId.length===0||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))fail('REMOTE_BRIDGE_PROCESS_START_CLAIM_INVALID');
    return value as unknown as StartClaim;
  }
  async function createStartClaim(claim:StartClaim):Promise<boolean>{
    const path=claimPath(claim.ownerDigest);
    try{await writeFile(path,JSON.stringify(claim)+'\n',{mode:0o600,flag:'wx'});await chmod(path,0o600);return true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return false;throw error;}
  }
  async function replayStartClaim(ownerDigest:string,profileId:string,claim:StartClaim){
    if(claim.ownerDigest!==ownerDigest||claim.profileId!==profileId)fail('REMOTE_BRIDGE_PROCESS_START_CLAIM_MISMATCH');
    let record:RemoteBridgeProcessSessionRecord;
    try{record=await loadRecord(claim.sessionId);}
    catch(error){if(error instanceof Error&&error.message==='REMOTE_BRIDGE_PROCESS_SESSION_NOT_FOUND')fail('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');throw error;}
    assertOwner(record,ownerDigest);
    if(record.state==='STARTING')fail('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');
    const current=await reconcile(record);
    return {...safePublic(current),ownerDigest,replay:true};
  }
  async function start(ownerDigest:string,args:Record<string,unknown>){
    digest(ownerDigest);exactKeys(args,['profileId','cwd'],['argv','lifetimeMs']);
    if(typeof args.profileId!=='string')fail('REMOTE_BRIDGE_PROCESS_PROFILE_INVALID');
    const profile=resolver(args.profileId,args.argv??[]);
    const cwd=await allowedCwd(args.cwd,profile);
    const requestedLifetime=args.lifetimeMs??profile.maxLifetimeMs;
    if(typeof requestedLifetime!=='number'||!Number.isInteger(requestedLifetime)||requestedLifetime<1_000||requestedLifetime>profile.maxLifetimeMs)fail('REMOTE_BRIDGE_PROCESS_LIFETIME_INVALID');
    await ensureRoot();
    const claimed=await loadStartClaim(ownerDigest);
    if(claimed)return await replayStartClaim(ownerDigest,profile.id,claimed);
    const existing=await existingForOwner(ownerDigest);
    if(existing){assertOwner(existing,ownerDigest);const current=await reconcile(existing);return {...safePublic(current),ownerDigest,replay:true};}
    const id=randomBytes(16).toString('hex'),p=paths(id),created=clock();
    const claim:StartClaim={schema:START_CLAIM_SCHEMA,ownerDigest,sessionId:id,profileId:profile.id,createdAt:created.toISOString()};
    if(!await createStartClaim(claim)){
      const winner=await loadStartClaim(ownerDigest);if(!winner)fail('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');
      return await replayStartClaim(ownerDigest,profile.id,winner);
    }
    await mkdir(p.dir,{mode:0o700});await chmod(p.dir,0o700);
    const spec:RemoteBridgeProcessSupervisorSpec={
      schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SUPERVISOR_SPEC_V1',sessionId:id,ownerDigest,profileId:profile.id,
      executable:profile.executable,args:[...profile.args],cwd,createdAt:created.toISOString(),
      expiresAt:new Date(created.getTime()+requestedLifetime).toISOString(),maxOutputBytes:profile.maxOutputBytes,
      stdinMode:profile.stdinMode,maxInputBytes:profile.maxInputBytes,forceKillAfterMs:profile.forceKillAfterMs,
      sessionDir:p.dir,recordPath:p.record,outputPath:p.output,socketPath:p.socket
    };
    await writeFile(p.spec,JSON.stringify(spec)+'\n',{mode:0o600,flag:'wx'});await chmod(p.spec,0o600);
    try{await launch(p.spec,id);}catch{fail('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');}
    let record:RemoteBridgeProcessSessionRecord|null=null;
    for(let attempt=0;attempt<200;attempt++){
      try{record=await loadRecord(id);if(record.state!=='STARTING')break;}catch{}
      await delay(20);
    }
    if(!record||record.state==='STARTING')fail('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');
    assertOwner(record,ownerDigest);
    return {...safePublic(record),ownerDigest,replay:false};
  }
  async function status(id:string,ownerDigest:string){
    const record=await loadRecord(id);assertOwner(record,ownerDigest);return safePublic(await reconcile(record));
  }
  async function readOutput(id:string,ownerDigest:string,cursorValue:unknown,maxValue:unknown){
    const record=await loadRecord(id);assertOwner(record,ownerDigest);const current=await reconcile(record);
    const cursor=cursorValue===undefined?0:cursorValue,maxBytes=maxValue===undefined?65_536:maxValue;
    if(typeof cursor!=='number'||!Number.isInteger(cursor)||cursor<0)fail('REMOTE_BRIDGE_PROCESS_CURSOR_INVALID');
    if(typeof maxBytes!=='number'||!Number.isInteger(maxBytes)||maxBytes<8192||maxBytes>131_072)fail('REMOTE_BRIDGE_PROCESS_READ_LIMIT_INVALID');
    let data:Buffer;try{data=await readFile(paths(id).output);}catch{data=Buffer.alloc(0);}
    if(cursor>data.length)fail('REMOTE_BRIDGE_PROCESS_CURSOR_INVALID');
    const chunks:Array<{stream:'stdout'|'stderr';dataBase64:string}>=[];
    let position=cursor,used=0;
    while(position<data.length){
      const newline=data.indexOf(0x0a,position);if(newline<0)break;
      const lineBytes=newline+1-position;if(chunks.length>0&&used+lineBytes>maxBytes)break;
      if(lineBytes>maxBytes&&chunks.length===0)fail('REMOTE_BRIDGE_PROCESS_READ_LIMIT_TOO_SMALL');
      const parsed=row(JSON.parse(data.subarray(position,newline).toString('utf8')),'REMOTE_BRIDGE_PROCESS_OUTPUT_INVALID');
      if((parsed.stream!=='stdout'&&parsed.stream!=='stderr')||typeof parsed.dataBase64!=='string')fail('REMOTE_BRIDGE_PROCESS_OUTPUT_INVALID');
      chunks.push({stream:parsed.stream,dataBase64:parsed.dataBase64});used+=lineBytes;position=newline+1;
    }
    return {schema:'COCWIN_REMOTE_BRIDGE_PROCESS_OUTPUT_V1',sessionId:id,cursor,nextCursor:position,eof:TERMINAL.has(current.state)&&position>=data.length,chunks};
  }
  async function writeInput(id:string,ownerDigest:string,data:unknown,actionId:string){
    digest(actionId);
    const record=await loadRecord(id);assertOwner(record,ownerDigest);
    if(typeof data!=='string')fail('REMOTE_BRIDGE_PROCESS_INPUT_INVALID');
    return await sendCommand(id,{action:'WRITE_INPUT',sessionId:id,ownerDigest,actionId,data});
  }
  async function terminate(id:string,ownerDigest:string,actionId:string){
    digest(actionId);const record=await loadRecord(id);assertOwner(record,ownerDigest);
    if(TERMINAL.has(record.state))return safePublic(record);
    return await sendCommand(id,{action:'TERMINATE',sessionId:id,ownerDigest,actionId});
  }
  async function execute(operation:ProcessOperation,requestDigest:string):Promise<unknown>{
    digest(requestDigest);const args=row(operation.args,'REMOTE_BRIDGE_PROCESS_ARGS_INVALID');
    if(operation.action==='START')return await start(requestDigest,args);
    const id=sessionId(operation.sessionId);
    if(operation.action==='STATUS'){exactKeys(args,['ownerDigest']);return await status(id,digest(args.ownerDigest));}
    if(operation.action==='READ_OUTPUT'){exactKeys(args,['ownerDigest'],['cursor','maxBytes']);return await readOutput(id,digest(args.ownerDigest),args.cursor,args.maxBytes);}
    if(operation.action==='WRITE_INPUT'){exactKeys(args,['ownerDigest','data']);return await writeInput(id,digest(args.ownerDigest),args.data,requestDigest);}
    if(operation.action==='TERMINATE'){exactKeys(args,['ownerDigest']);return await terminate(id,digest(args.ownerDigest),requestDigest);}
    fail('REMOTE_BRIDGE_PROCESS_ACTION_INVALID');
  }
  async function stats():Promise<{activeSessions:number}>{
    await ensureRoot();let active=0;
    for(const entry of await readdir(root,{withFileTypes:true})){
      if(!entry.isDirectory()||!SESSION_RE.test(entry.name))continue;
      try{const value=await loadRecord(entry.name);if(!TERMINAL.has(value.state))active++;}catch{}
    }
    return {activeSessions:active};
  }
  return {execute,start,status,readOutput,writeInput,terminate,stats};
}
