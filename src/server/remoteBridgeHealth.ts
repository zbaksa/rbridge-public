export interface RemoteBridgeHealthCounts {queueCount:number;sessionCount:number;transferCount:number;}
export interface RemoteBridgeHealthOptions {releaseSha:string;startedAt:Date;now?:()=>Date;counts:()=>RemoteBridgeHealthCounts;}
export interface RemoteBridgeHealthSnapshot {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2';status:'PASS';releaseSha:string;uptimeMs:number;queueCount:number;sessionCount:number;transferCount:number;lastGitHubPollAt:string|null;}
const SHA_RE=/^[0-9a-f]{40}$/;
function fail(code:string):never{throw new Error(code);}
function canonicalDate(value:Date,code:string){const ms=value.getTime();if(!Number.isFinite(ms)||value.toISOString()!==new Date(ms).toISOString())fail(code);return ms;}
function count(value:number){if(!Number.isSafeInteger(value)||value<0||value>1_000_000)fail('REMOTE_BRIDGE_HEALTH_COUNT_INVALID');return value;}

export function createRemoteBridgeHealth(options:RemoteBridgeHealthOptions){
  if(!options||typeof options.releaseSha!=='string'||!SHA_RE.test(options.releaseSha))fail('REMOTE_BRIDGE_HEALTH_RELEASE_INVALID');
  const startedAt=canonicalDate(options.startedAt,'REMOTE_BRIDGE_HEALTH_TIME_INVALID'),now=options.now??(()=>new Date());let lastGitHubPollAt:string|null=null;
  return {
    recordGitHubPoll(at:Date=now()){const stamp=canonicalDate(at,'REMOTE_BRIDGE_HEALTH_TIME_INVALID');if(stamp<startedAt)fail('REMOTE_BRIDGE_HEALTH_TIME_INVALID');lastGitHubPollAt=new Date(stamp).toISOString();},
    snapshot():RemoteBridgeHealthSnapshot{const stamp=canonicalDate(now(),'REMOTE_BRIDGE_HEALTH_TIME_INVALID');if(stamp<startedAt)fail('REMOTE_BRIDGE_HEALTH_TIME_INVALID');const counts=options.counts();if(!counts||typeof counts!=='object')fail('REMOTE_BRIDGE_HEALTH_COUNT_INVALID');return {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:options.releaseSha,uptimeMs:stamp-startedAt,queueCount:count(counts.queueCount),sessionCount:count(counts.sessionCount),transferCount:count(counts.transferCount),lastGitHubPollAt};}
  };
}