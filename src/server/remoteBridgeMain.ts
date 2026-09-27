import {userInfo} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createControllerExecRemoteBridge} from '../adapters/controllerExecRemoteBridge.js';
import {createGitHubIssueRemoteBridge} from '../adapters/githubIssueRemoteBridge.js';
import {createRemoteBridgeChunkStore} from './remoteBridgeChunkStore.js';
import {createRemoteBridgeFileOps} from './remoteBridgeFileOps.js';
import {createRemoteBridgeHealth} from './remoteBridgeHealth.js';
import {createRemoteBridgeProcessSessions} from './remoteBridgeProcessSessions.js';
import {acquireRemoteBridgeProcessLock,createRemoteBridgeStore} from './remoteBridgeStore.js';
import {createRemoteBridgeWorker,type RemoteBridgeRunSummary} from './remoteBridgeWorker.js';
import {resolveHostProfile} from '../domain/remoteBridgeHostProfiles.js';

interface LoopLock {release():Promise<void>;}
export interface RemoteBridgeLoopOptions {acquireLock:()=>Promise<LoopLock>;runOnce:()=>Promise<RemoteBridgeRunSummary>;shouldContinue:()=>boolean;sleep:(ms:number)=>Promise<void>;log:(value:Record<string,unknown>)=>void;pollMs:number;maxBackoffMs?:number;now?:()=>Date;}
function reason(error:unknown){return error instanceof Error&&error.message?error.message.split('\n')[0]!.slice(0,512):'REMOTE_BRIDGE_UNKNOWN_ERROR';}
function rateLimited(value:string){return /(?:\\b429\\b|rate[- ]?limit|secondary rate limit)/i.test(value);}
export function resolveRemoteBridgeGitHubConfig(env:Record<string,string|undefined>){
  const repository=(env.RBRIDGE_GITHUB_REPOSITORY??'').trim(),authorLogin=(env.RBRIDGE_GITHUB_AUTHOR??'').trim();
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');
  if(!/^[A-Za-z0-9-]{1,39}$/.test(authorLogin))throw new Error('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');
  return {repository,authorLogin};
}
export async function runRemoteBridgeLoop(options:RemoteBridgeLoopOptions):Promise<void>{
  const lock=await options.acquireLock(),now=options.now??(()=>new Date()),maxBackoffMs=Math.max(options.pollMs,options.maxBackoffMs??60_000);let errorStreak=0;
  try{while(options.shouldContinue()){
    let sleepMs=options.pollMs;
    try{const summary=await options.runOnce();errorStreak=0;options.log({schema:'COCWIN_REMOTE_BRIDGE_TICK_V1',status:'PASS',at:now().toISOString(),summary});}
    catch(error){errorStreak=Math.min(errorStreak+1,16);const failure=reason(error),exponential=Math.min(maxBackoffMs,options.pollMs*(2**errorStreak));sleepMs=rateLimited(failure)?maxBackoffMs:exponential;options.log({schema:'COCWIN_REMOTE_BRIDGE_TICK_V1',status:'ERROR',at:now().toISOString(),reason:failure,retryInMs:sleepMs});}
    if(!options.shouldContinue())break;await options.sleep(sleepMs);
  }}finally{await lock.release();}
}

export async function runRemoteBridgeMain():Promise<void>{
  const user=userInfo();if(user.username!=='bai'||(typeof process.getuid==='function'&&process.getuid()===0))throw new Error('REMOTE_BRIDGE_BAI_REQUIRED');if(!user.homedir.startsWith('/')||user.homedir==='/'||user.homedir==='/root')throw new Error('REMOTE_BRIDGE_HOME_INVALID');
  const {repository,authorLogin}=resolveRemoteBridgeGitHubConfig(process.env);
  const root=join(user.homedir,'.local','state','cocwin-remote-bridge'),store=createRemoteBridgeStore(root),github=createGitHubIssueRemoteBridge({repository,authorLogin}),controller=createControllerExecRemoteBridge(),chunkStore=createRemoteBridgeChunkStore({root:join(root,'transfers')}),processSessions=createRemoteBridgeProcessSessions({root:join(root,'sessions')});
  let queueCount=0,sessionCount=(await processSessions.stats()).activeSessions,transferCount=(await chunkStore.stats()).activeTransfers;
  const releaseSha=process.env.COCWIN_REMOTE_BRIDGE_RELEASE_SHA??'',health=createRemoteBridgeHealth({releaseSha,startedAt:new Date(),counts:()=>({queueCount,sessionCount,transferCount})});
  // Construct FILE ops from source-controlled host profile
  const fileProfile=resolveHostProfile({kind:'FILE',action:'LIST',target:'/mnt/data',args:{}});
  if(fileProfile.kind!=='FILE')throw new Error('REMOTE_BRIDGE_FILE_PROFILE_INVALID');
  const fileOps=createRemoteBridgeFileOps({
    allowedRoots:fileProfile.allowedRoots,
    maxReadBytes:fileProfile.maxReadBytes,
    maxSearchResults:fileProfile.maxSearchResults
  });
  const worker=createRemoteBridgeWorker({store,github,controller,chunkStore,health,processSessions,fileOps,repository,authorLogin});let running=true;const stop=()=>{running=false;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{await runRemoteBridgeLoop({acquireLock:async()=>await acquireRemoteBridgeProcessLock(root),runOnce:async()=>{const summary=await worker.runOnce();queueCount=summary.pending;sessionCount=(await processSessions.stats()).activeSessions;transferCount=(await chunkStore.stats()).activeTransfers;health.recordGitHubPoll();return summary;},shouldContinue:()=>running,sleep:async ms=>{await delay(ms);},log:value=>console.log(JSON.stringify(value)),pollMs:2000,maxBackoffMs:60_000});}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}

if(process.argv[1]?.endsWith('/remoteBridgeMain.js')){runRemoteBridgeMain().catch(error=>{console.error(JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_FATAL_V1',status:'FAIL',reason:reason(error)}));process.exitCode=1;});}