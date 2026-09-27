import type {RemoteBridgeStage2Operation} from './remoteBridgeStage2Protocol.js';

type Base={readonly sourceControlled:true};
export type RemoteBridgeHostProfile=
 | (Base&{readonly kind:'APP_RUN';readonly authority:'AI_TOOL_FABRIC_CONTROLLER'})
 | (Base&{readonly kind:'FILE';readonly allowedRoots:readonly string[];readonly maxReadBytes:number;readonly maxSearchResults:number})
 | (Base&{readonly kind:'PROCESS';readonly profileIds:readonly string[];readonly maxLifetimeMs:number;readonly maxOutputBytes:number})
 | (Base&{readonly kind:'CHUNK';readonly maxChunkBytes:number;readonly maxTransferBytes:number})
 | (Base&{readonly kind:'HEALTH';readonly safeFields:readonly string[]});

export type RemoteBridgeResolvedProcessProfile={
  readonly id:string;
  readonly executable:string;
  readonly args:readonly string[];
  readonly cwdRoots:readonly string[];
  readonly maxLifetimeMs:number;
  readonly maxOutputBytes:number;
  readonly stdinMode:'DENY'|'UTF8';
  readonly maxInputBytes:number;
  readonly forceKillAfterMs:number|null;
};

const PROCESS_ROOTS=Object.freeze(['/mnt/data']);
const ECHO_SOURCE="process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d));process.stdin.resume();";

const APP_RUN=Object.freeze({sourceControlled:true as const,kind:'APP_RUN' as const,authority:'AI_TOOL_FABRIC_CONTROLLER' as const});
const FILE=Object.freeze({sourceControlled:true as const,kind:'FILE' as const,allowedRoots:Object.freeze(['/mnt/data']),maxReadBytes:1_048_576,maxSearchResults:500});
const PROCESS_IDS=Object.freeze(['git-read','node-safe','stdin-echo']);
const PROCESS=Object.freeze({sourceControlled:true as const,kind:'PROCESS' as const,profileIds:PROCESS_IDS,maxLifetimeMs:1_800_000,maxOutputBytes:1_048_576});
const CHUNK=Object.freeze({sourceControlled:true as const,kind:'CHUNK' as const,maxChunkBytes:48_000,maxTransferBytes:16*1024*1024});
const HEALTH=Object.freeze({sourceControlled:true as const,kind:'HEALTH' as const,safeFields:Object.freeze(['releaseSha','uptimeMs','queueCount','sessionCount','transferCount','lastGitHubPollAt'])});

function fail(code:string):never{throw new Error(code);}
function requestArgs(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>32)fail('REMOTE_BRIDGE_PROCESS_ARGS_INVALID');
  const out:string[]=[];
  let total=0;
  for(const item of value){
    if(typeof item!=='string'||item.includes('\0')||Buffer.byteLength(item)>4096)fail('REMOTE_BRIDGE_PROCESS_ARGS_INVALID');
    total+=Buffer.byteLength(item);out.push(item);
  }
  if(total>16_384)fail('REMOTE_BRIDGE_PROCESS_ARGS_INVALID');
  return out;
}
function same(args:readonly string[],expected:readonly string[]):boolean{return args.length===expected.length&&args.every((value,index)=>value===expected[index]);}
function frozenProfile(value:RemoteBridgeResolvedProcessProfile):RemoteBridgeResolvedProcessProfile{
  return Object.freeze({...value,args:Object.freeze([...value.args]),cwdRoots:PROCESS_ROOTS});
}

export function resolveRemoteBridgeProcessCommandProfile(profileId:string,argv:unknown):RemoteBridgeResolvedProcessProfile{
  const requested=requestArgs(argv);
  if(profileId==='git-read'){
    const accepted=[['--version']] as const;
    if(!accepted.some(value=>same(requested,value)))fail('REMOTE_BRIDGE_PROCESS_ARGS_NOT_ALLOWED');
    return frozenProfile({id:'git-read',executable:'/usr/bin/git',args:requested,cwdRoots:PROCESS_ROOTS,maxLifetimeMs:120_000,maxOutputBytes:262_144,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:2_000});
  }
  if(profileId==='node-safe'){
    if(!same(requested,['--version']))fail('REMOTE_BRIDGE_PROCESS_ARGS_NOT_ALLOWED');
    return frozenProfile({id:'node-safe',executable:'/opt/ai-tool-fabric/runtime/node',args:requested,cwdRoots:PROCESS_ROOTS,maxLifetimeMs:30_000,maxOutputBytes:65_536,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:2_000});
  }
  if(profileId==='stdin-echo'){
    if(requested.length!==0)fail('REMOTE_BRIDGE_PROCESS_ARGS_NOT_ALLOWED');
    return frozenProfile({id:'stdin-echo',executable:'/opt/ai-tool-fabric/runtime/node',args:['-e',ECHO_SOURCE],cwdRoots:PROCESS_ROOTS,maxLifetimeMs:300_000,maxOutputBytes:262_144,stdinMode:'UTF8',maxInputBytes:65_536,forceKillAfterMs:2_000});
  }
  fail('REMOTE_BRIDGE_PROCESS_PROFILE_NOT_ALLOWED');
}

export function resolveHostProfile(operation:RemoteBridgeStage2Operation):RemoteBridgeHostProfile{
  switch(operation.kind){
    case 'APP_RUN':return APP_RUN;
    case 'FILE':return FILE;
    case 'PROCESS':return PROCESS;
    case 'CHUNK':return CHUNK;
    case 'HEALTH':return HEALTH;
    default:throw new Error('REMOTE_BRIDGE_HOST_PROFILE_INVALID');
  }
}
