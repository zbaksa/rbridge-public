import {startRBridgeOwnerRuntime,type RBridgeOwnerRuntime} from './rbridgeOwnerRuntime.js';
import {assertRBridgeOwnerLockHeld} from './rbridgeOwnerLock.js';
import {createRBridgeStateFiles} from './rbridgeStateFiles.js';
import {createRBridgeLegacyReservations} from './rbridgeLegacyReservations.js';
import {resolveRBridgeMcpStdioBinding} from './rbridgeMcpSafe.js';
import {resolveRBridgeMcpStateRoot} from './rbridgeMcpMain.js';
import {readFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createControllerExecRemoteBridge} from '../adapters/controllerExecRemoteBridge.js';
import {createGitHubIssueRemoteBridge} from '../adapters/githubIssueRemoteBridge.js';
import {createFlowPilotBridgeRuntime} from './flowPilotBridgeRuntime.js';
import {runFlowPilotBridgeTick} from './flowPilotBridgeTick.js';
import {createRemoteBridgeChunkStore} from './remoteBridgeChunkStore.js';
import {createRemoteBridgeFileOps} from './remoteBridgeFileOps.js';
import {createRemoteBridgeHealth} from './remoteBridgeHealth.js';
import {createRemoteBridgeProcessSessions} from './remoteBridgeProcessSessions.js';
import {acquireRemoteBridgeProcessLock,createRemoteBridgeStore} from './remoteBridgeStore.js';
import {createRemoteBridgeWorker,type RemoteBridgeRunSummary} from './remoteBridgeWorker.js';
import {resolveHostProfile} from '../domain/remoteBridgeHostProfiles.js';

interface LoopLock {release():Promise<void>;}
export function createRemoteBridgeLifecycleLock(options:{relay:LoopLock;owner:{close(beforeOwnerRelease?:()=>Promise<void>):Promise<void>};stopIngress:()=>Promise<void>}):LoopLock{
  let closing:Promise<void>|undefined;
  return {release(){return closing??=(async()=>{
    let stopped:Promise<void>;try{stopped=options.stopIngress();}catch(error){stopped=Promise.reject(error);}
    void stopped.catch(()=>undefined);
    await options.owner.close(async()=>{await stopped;});
    await options.relay.release();
  })();}};
}
export interface RemoteBridgeLoopOptions {acquireLock:()=>Promise<LoopLock>;onLocked?:()=>Promise<void>;runOnce:()=>Promise<RemoteBridgeRunSummary>;shouldContinue:()=>boolean;sleep:(ms:number)=>Promise<void>;log:(value:Record<string,unknown>)=>void;pollMs:number;maxBackoffMs?:number;now?:()=>Date;}
function reason(error:unknown){return error instanceof Error&&error.message?error.message.split('\n')[0]!.slice(0,512):'REMOTE_BRIDGE_UNKNOWN_ERROR';}
function rateLimited(value:string){return /(?:\\b429\\b|rate[- ]?limit|secondary rate limit)/i.test(value);}
export function resolveRemoteBridgeGitHubConfig(env:Record<string,string|undefined>){
  const repository=(env.RBRIDGE_GITHUB_REPOSITORY??'').trim(),authorLogin=(env.RBRIDGE_GITHUB_AUTHOR??'').trim();
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');
  if(!/^[A-Za-z0-9-]{1,39}$/.test(authorLogin))throw new Error('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');
  return {repository,authorLogin};
}
export function resolveRemoteBridgeRuntimeConfig(env:Record<string,string|undefined>,identity:{username:string;homedir:string;uid:number}){
  const runtimeUser=(env.RBRIDGE_RUNTIME_USER??'').trim();
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(runtimeUser))throw new Error('REMOTE_BRIDGE_RUNTIME_USER_CONFIG_INVALID');
  if(identity.uid===0||identity.username!==runtimeUser)throw new Error('REMOTE_BRIDGE_RUNTIME_USER_REQUIRED');
  if(!identity.homedir.startsWith('/')||identity.homedir==='/'||identity.homedir==='/root'||identity.homedir.includes('\0'))throw new Error('REMOTE_BRIDGE_HOME_INVALID');
  return {runtimeUser,stateRoot:join(identity.homedir,'.local','state','rbridge')};
}

export function resolveRemoteBridgeInstanceId(env:Record<string,string|undefined>,machineIdRaw?:string){
  const configured=(env.RBRIDGE_INSTANCE_ID??'').trim();
  if(configured){
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configured))throw new Error('REMOTE_BRIDGE_INSTANCE_ID_INVALID');
    return configured;
  }
  const raw=machineIdRaw??readFileSync('/etc/machine-id','utf8');
  const machineId=raw.trim().toLowerCase();
  if(!/^[0-9a-f]{32}$/.test(machineId))throw new Error('REMOTE_BRIDGE_INSTANCE_ID_INVALID');
  return `machine-${machineId}`;
}
export async function runRemoteBridgeLoop(options:RemoteBridgeLoopOptions):Promise<void>{
  const lock=await options.acquireLock(),now=options.now??(()=>new Date()),maxBackoffMs=Math.max(options.pollMs,options.maxBackoffMs??60_000);let errorStreak=0;
  try{await options.onLocked?.();while(options.shouldContinue()){
    let sleepMs=options.pollMs;
    try{const summary=await options.runOnce();errorStreak=0;options.log({schema:'COCWIN_REMOTE_BRIDGE_TICK_V1',status:'PASS',at:now().toISOString(),summary});}
    catch(error){errorStreak=Math.min(errorStreak+1,16);const failure=reason(error),exponential=Math.min(maxBackoffMs,options.pollMs*(2**errorStreak));sleepMs=rateLimited(failure)?maxBackoffMs:exponential;options.log({schema:'COCWIN_REMOTE_BRIDGE_TICK_V1',status:'ERROR',at:now().toISOString(),reason:failure,retryInMs:sleepMs});}
    if(!options.shouldContinue())break;await options.sleep(sleepMs);
  }}finally{await lock.release();}
}

export async function runRemoteBridgeMain():Promise<void>{
  const user=userInfo(),uid=typeof process.getuid==='function'?process.getuid():user.uid,euid=typeof process.geteuid==='function'?process.geteuid():user.uid;
  if(user.uid!==uid||user.uid!==euid)throw new Error('RBRIDGE_MCP_RUNTIME_IDENTITY_INVALID');
  const identity={username:user.username,homedir:user.homedir,uid,euid};
  resolveRemoteBridgeRuntimeConfig(process.env,identity);
  const binding=resolveRBridgeMcpStdioBinding(process.env,identity),coreRoot=resolveRBridgeMcpStateRoot(user.homedir),root=dirname(coreRoot),instanceId=binding.targetInstanceId;
  const {repository,authorLogin}=resolveRemoteBridgeGitHubConfig(process.env),github=createGitHubIssueRemoteBridge({repository,authorLogin});
  let queueCount=0,sessionCount=0,transferCount=0;
  const releaseSha=process.env.RBRIDGE_RELEASE_SHA??process.env.COCWIN_REMOTE_BRIDGE_RELEASE_SHA??'',health=createRemoteBridgeHealth({releaseSha,startedAt:new Date(),counts:()=>({queueCount,sessionCount,transferCount})});
  let worker:ReturnType<typeof createRemoteBridgeWorker>|undefined,flowPilot:ReturnType<typeof createFlowPilotBridgeRuntime>,chunkStore:ReturnType<typeof createRemoteBridgeChunkStore>|undefined,processSessions:ReturnType<typeof createRemoteBridgeProcessSessions>|undefined;
  let running=true;const stop=()=>{running=false;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    await runRemoteBridgeLoop({
      acquireLock:async()=>{
        // Only bootstrap missing directories; existing unsafe permissions remain evidence.
        const files=createRBridgeStateFiles();
        for(const path of [join(user.homedir,'.local'),join(user.homedir,'.local','state')]){
          try{const checked=await files.directory(path,uid);await checked.close();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await files.ensureDirectory(path,uid);}
        }
        await files.ensureDirectory(root,uid);await files.validateTree(root,uid);
        const relay=await acquireRemoteBridgeProcessLock(root);let owner:RBridgeOwnerRuntime|undefined;
        try{
          owner=await startRBridgeOwnerRuntime({runtimeIdentity:identity,env:process.env,github,health});
          const store=createRemoteBridgeStore(root,undefined,{claimGuard:owner.claimGuard}),controller=createControllerExecRemoteBridge();
          // Validate legacy roots before legacy factories can create or chmod them.
          for(const path of [join(root,'flowpilot'),join(root,'sessions'),join(root,'transfers')]){
            try{const checked=await files.directory(path,uid,true);await checked.close();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          }
          chunkStore=createRemoteBridgeChunkStore({root:join(root,'transfers')});processSessions=createRemoteBridgeProcessSessions({root:join(root,'sessions')});
          flowPilot=createFlowPilotBridgeRuntime({root,controller,env:process.env,claimGuard:owner.claimGuard});
          sessionCount=(await processSessions.stats()).activeSessions;transferCount=(await chunkStore.stats()).activeTransfers;
          const fileProfile=resolveHostProfile({kind:'FILE',action:'LIST',target:'/mnt/data',args:{}});
          if(fileProfile.kind!=='FILE')throw new Error('REMOTE_BRIDGE_FILE_PROFILE_INVALID');
          const fileOps=createRemoteBridgeFileOps({allowedRoots:fileProfile.allowedRoots,maxReadBytes:fileProfile.maxReadBytes,maxSearchResults:fileProfile.maxSearchResults});
          const reservations=createRBridgeLegacyReservations({requestRoot:root,flowPilotRoot:join(root,'flowpilot'),uid});
          worker=createRemoteBridgeWorker({store,github,githubCore:owner.githubCore,reservations,controller,chunkStore,health,processSessions,fileOps,repository,authorLogin,instanceId});
          return createRemoteBridgeLifecycleLock({relay,owner,stopIngress:async()=>{await flowPilot?.stop();}});
        }catch(error){
          if(owner)await createRemoteBridgeLifecycleLock({relay,owner,stopIngress:async()=>{await flowPilot?.stop();}}).release();
          else{
            let retained=false;try{assertRBridgeOwnerLockHeld(coreRoot);retained=true;}catch{/* Failed startup closed its owner FD. */}
            if(!retained)await relay.release();
          }
          throw error;
        }
      },
      onLocked:async()=>{
        const address=await flowPilot?.start();
        if(address)console.log(JSON.stringify({schema:'COCWIN_FLOWPILOT_BRIDGE_INGRESS_V1',status:'LISTENING',host:address.host,port:address.port}));
      },
      runOnce:async()=>{
        if(!worker||!processSessions||!chunkStore)throw new Error('RBRIDGE_OWNER_NOT_READY');
        const summary=await runFlowPilotBridgeTick({runPrimary:async()=>await worker!.runOnce(),...(flowPilot?{reconcile:async()=>await flowPilot!.reconcile()}:{}),log:value=>console.log(JSON.stringify(value))});
        queueCount=summary.pending;sessionCount=(await processSessions.stats()).activeSessions;transferCount=(await chunkStore.stats()).activeTransfers;health.recordGitHubPoll();return summary;
      },
      shouldContinue:()=>running,sleep:async ms=>{await delay(ms);},log:value=>console.log(JSON.stringify(value)),pollMs:2000,maxBackoffMs:60_000
    });
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}

if(process.argv[1]?.endsWith('/remoteBridgeMain.js')){runRemoteBridgeMain().catch(error=>{console.error(JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_FATAL_V1',status:'FAIL',reason:reason(error)}));process.exitCode=1;});}