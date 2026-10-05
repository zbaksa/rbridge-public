import {join,relative} from 'node:path';
import type {RBridgeJsonValue,RBridgeOperationSubmissionV1} from '../domain/rbridgeExecutionContract.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgePolicyDocument} from './rbridgeExecutionJournal.js';
import {evaluateRBridgePolicyDocument,freezeRBridgeValue,isRBridgePolicyRecoveryAllowed,type RBridgeExecutionPolicy,type RBridgePolicyDocumentV1} from './rbridgeExecutionPolicy.js';
import {createRemoteBridgeFileOps} from './remoteBridgeFileOps.js';
export interface RBridgeReadonlyHandler{execute(submission:RBridgeOperationSubmissionV1,originalPolicy:RBridgePolicyDocumentV1,currentPolicy:RBridgePolicyDocumentV1,signal:AbortSignal):Promise<RBridgeJsonValue>;}
function fail(code:string):never{throw new Error(code);}
function health(value:unknown):RBridgeJsonValue{
  const code='RBRIDGE_READ_HEALTH_INVALID';
  try{
    assertBoundedRBridgeJson(value,{bytes:4096,depth:2,nodes:32});
    if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
    const row=value as Record<string,unknown>,keys=['schema','status','releaseSha','uptimeMs','queueCount','sessionCount','transferCount','lastGitHubPollAt'];
    if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.schema!=='COCWIN_REMOTE_BRIDGE_HEALTH_V2'||row.status!=='PASS'||typeof row.releaseSha!=='string'||!/^[0-9a-f]{40}$/.test(row.releaseSha))fail(code);
    if(typeof row.uptimeMs!=='number'||!Number.isSafeInteger(row.uptimeMs)||row.uptimeMs<0)fail(code);
    for(const key of ['queueCount','sessionCount','transferCount']){const count=row[key];if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0||count>1000000)fail(code);}
    const stamp=row.lastGitHubPollAt;if(stamp!==null&&(typeof stamp!=='string'||!Number.isFinite(Date.parse(stamp))||new Date(stamp).toISOString()!==stamp))fail(code);
    return JSON.parse(canonicalRBridgeJson(value as RBridgeJsonValue)) as RBridgeJsonValue;
  }catch{fail(code);}
}
function sanitized(error:unknown):never{
  const message=error instanceof Error?error.message:'',code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
  if(code==='ENOENT')fail('RBRIDGE_READ_NOT_FOUND');
  const allowed=['TOO_LARGE','BINARY_REQUIRES_CHUNK','SYMLINK_DENIED','ROOT_DENIED','SECRET_PATH','NOT_FILE','NOT_DIRECTORY','PATH_INVALID','LIST_SCAN_LIMIT','SEARCH_SCAN_LIMIT'];
  const suffix=message.replace(/^REMOTE_BRIDGE_FILE_/,'');if(allowed.includes(suffix))fail(`RBRIDGE_READ_${suffix}`);
  fail('RBRIDGE_READ_FAILED');
}
export function createRBridgeReadonlyHandlers(options:{health:{snapshot():unknown|Promise<unknown>};policy:RBridgeExecutionPolicy;sourceRoot?:string}):RBridgeReadonlyHandler{
  const source=parseRBridgePolicyDocument(options.policy.document),sourceRoot=options.sourceRoot??'/mnt/data';
  // This root maps a fixed logical policy to an owner-constructed test source. It is
  // never part of a submission, environment override, or an RPC-selected policy.
  const checkRoot=createRemoteBridgeFileOps({allowedRoots:[sourceRoot],maxReadBytes:source.limits.readBytes,maxSearchResults:source.limits.searchMatches});void checkRoot;
  return {async execute(submission,originalValue,currentValue,signal){
    let original:RBridgePolicyDocumentV1,current:RBridgePolicyDocumentV1;
    try{original=parseRBridgePolicyDocument(originalValue);current=parseRBridgePolicyDocument(currentValue);
      if(original.binding.runtimeUid!==source.binding.runtimeUid||current.binding.runtimeUid!==source.binding.runtimeUid||!isRBridgePolicyRecoveryAllowed(original,current,submission)||evaluateRBridgePolicyDocument(source,submission).snapshot.decision!=='ALLOW')fail('RBRIDGE_READ_POLICY_BLOCKED');
    }catch{fail('RBRIDGE_READ_POLICY_BLOCKED');}
    const limits=Object.fromEntries(Object.keys(source.limits).map(key=>{const name=key as keyof typeof source.limits;return [key,Math.min(source.limits[name],original.limits[name],current.limits[name])];})) as Record<keyof typeof source.limits,number>;
    const controller=new AbortController();let timedOut=false;
    const onAbort=()=>controller.abort();signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},limits.handlerMs);
    function check(){if(controller.signal.aborted)fail(timedOut?'RBRIDGE_READ_DEADLINE':'RBRIDGE_READ_ABORTED');}
    try{
      check();let output:RBridgeJsonValue;
      if(submission.operation.kind==='HEALTH'){let observed:unknown;try{observed=await options.health.snapshot();}catch{check();fail('RBRIDGE_READ_FAILED');}check();output=health(observed);}
      else if(submission.operation.kind==='FILE'){
        const operation=submission.operation;
        const files=createRemoteBridgeFileOps({allowedRoots:[sourceRoot],maxReadBytes:limits.readBytes,maxSearchResults:limits.searchMatches,maxPaths:limits.paths,maxListEntries:limits.listEntries,maxScanEntries:limits.scanEntries,maxSearchDepth:limits.searchDepth});
        const physicalTarget=join(sourceRoot,relative('/mnt/data',operation.target));
        let observed:unknown;
        try{observed=await files.execute({...operation,target:physicalTarget},{signal:controller.signal});}catch(error){check();sanitized(error);}
        check();output=observed as RBridgeJsonValue;
        const row=output as {[key:string]:RBridgeJsonValue};
        const logical=(path:RBridgeJsonValue)=>typeof path==='string'?join('/mnt/data',relative(sourceRoot,path)):fail('RBRIDGE_READ_FAILED');
        if(Object.hasOwn(row,'path'))row.path=logical(row.path!);
        for(const key of ['files','matches'])if(Array.isArray(row[key]))for(const item of row[key]){const child=item as {[key:string]:RBridgeJsonValue};child.path=logical(child.path!);}
      }else fail('RBRIDGE_READ_POLICY_BLOCKED');
      try{assertBoundedRBridgeJson(output,{bytes:limits.outputBytes,depth:limits.depth,nodes:limits.nodes});}catch{fail('RBRIDGE_READ_OUTPUT_LIMIT');}
      check();return freezeRBridgeValue(output);
    }finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }};
}
