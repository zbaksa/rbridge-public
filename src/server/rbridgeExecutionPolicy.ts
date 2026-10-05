import {createHash} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {RBRIDGE_CORE_LIMITS,RBRIDGE_ENABLED_ACTIONS,type RBridgeDeploymentBinding,type RBridgeEnabledAction} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson,parseRBridgeDeploymentBinding} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue,RBridgeOperationSubmissionV1,RBridgePolicySnapshotV1} from '../domain/rbridgeExecutionContract.js';
import {assertRemoteBridgeFileTargetPolicy} from './remoteBridgeFileOps.js';

export interface RBridgePolicyDocumentV1{
  readonly schema:'RBRIDGE_POLICY_DOCUMENT_V1';readonly version:'safe-core-p2a-v1';readonly binding:Readonly<RBridgeDeploymentBinding>;
  readonly enabledActions:readonly RBridgeEnabledAction[];readonly allowedRoots:readonly string[];
  readonly limits:Readonly<typeof RBRIDGE_CORE_LIMITS>;
  readonly recovery:{readonly incompleteReadonly:'REOBSERVE';readonly mutation:'NEVER_RETRY'};
}
export interface RBridgePolicyDecision{document:RBridgePolicyDocumentV1;snapshot:RBridgePolicySnapshotV1;}
export interface RBridgeExecutionPolicy{readonly document:RBridgePolicyDocumentV1;evaluate(submission:RBridgeOperationSubmissionV1):RBridgePolicyDecision;}
export function freezeRBridgeValue<T>(value:T):T{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeRBridgeValue(child);Object.freeze(value);}return value;
}
function reasonFor(document:RBridgePolicyDocumentV1,submission:RBridgeOperationSubmissionV1):string|undefined{
  if(submission.principalId!==document.binding.principalId||submission.targetInstanceId!==document.binding.targetInstanceId)return 'RBRIDGE_POLICY_SCOPE_INVALID';
  const op=submission.operation,key=`${op.kind}/${op.action}`;
  if(!document.enabledActions.includes(key as RBridgeEnabledAction)||!RBRIDGE_ENABLED_ACTIONS.includes(key as RBridgeEnabledAction))return 'RBRIDGE_POLICY_ACTION_DISABLED';
  try{
    assertBoundedRBridgeJson(submission,{bytes:document.limits.submissionBytes,depth:document.limits.depth,nodes:document.limits.nodes});
    if(op.kind==='HEALTH')return undefined;
    if(op.kind!=='FILE')return 'RBRIDGE_POLICY_ACTION_DISABLED';
    assertRemoteBridgeFileTargetPolicy(op.target,document.allowedRoots);
    const keys=Object.keys(op.args);
    if(['STAT','READ','READ_BINARY'].includes(op.action)){if(keys.length)throw new Error();}
    else if(op.action==='LIST'){
      if(keys.some(k=>k!=='maxEntries'))throw new Error();
      const value=op.args.maxEntries;
      if(value!==undefined&&(typeof value!=='number'||!Number.isInteger(value)||value<1||value>document.limits.listEntries))throw new Error();
    }else if(op.action==='READ_MANY'){
      const paths=op.args.paths;
      if(keys.length!==1||keys[0]!=='paths'||!Array.isArray(paths)||paths.length<1||paths.length>document.limits.paths)throw new Error();
      for(const path of paths){
        if(typeof path!=='string'||Buffer.byteLength(path)>1024||path.includes('\0')||path.includes('\\')||isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error();
        assertRemoteBridgeFileTargetPolicy(join(op.target,path),document.allowedRoots);
      }
    }else if(op.action==='SEARCH'){
      const query=op.args.query;
      if(keys.length!==1||keys[0]!=='query'||typeof query!=='string'||!query||query.includes('\0')||Buffer.byteLength(query)>4096)throw new Error();
    }else return 'RBRIDGE_POLICY_ACTION_DISABLED';
    return undefined;
  }catch{return 'RBRIDGE_POLICY_ARGUMENT_OR_PATH_DENIED';}
}
export function createRBridgeExecutionPolicy(binding:RBridgeDeploymentBinding):RBridgeExecutionPolicy{
  const document:RBridgePolicyDocumentV1=freezeRBridgeValue({schema:'RBRIDGE_POLICY_DOCUMENT_V1',version:'safe-core-p2a-v1',binding:parseRBridgeDeploymentBinding(binding),enabledActions:[...RBRIDGE_ENABLED_ACTIONS],allowedRoots:['/mnt/data'],limits:{...RBRIDGE_CORE_LIMITS},recovery:{incompleteReadonly:'REOBSERVE',mutation:'NEVER_RETRY'}});
  const policySha256=createHash('sha256').update(canonicalRBridgeJson(document as unknown as RBridgeJsonValue)).digest('hex');
  return Object.freeze({document,evaluate(submission:RBridgeOperationSubmissionV1):RBridgePolicyDecision{
    const reason=reasonFor(document,submission);
    return freezeRBridgeValue({document,snapshot:{schema:'RBRIDGE_POLICY_SNAPSHOT_V1',mode:'SAFE',policyVersion:document.version,policySha256,decision:reason?'BLOCK':'ALLOW',...(reason?{reason}:{})}});
  }});
}
export function isRBridgePolicyRecoveryAllowed(original:RBridgePolicyDocumentV1,current:RBridgePolicyDocumentV1,submission:RBridgeOperationSubmissionV1):boolean{
  return original.binding.runtimeUid===current.binding.runtimeUid&&original.recovery.incompleteReadonly==='REOBSERVE'&&current.recovery.incompleteReadonly==='REOBSERVE'&&reasonFor(original,submission)===undefined&&reasonFor(current,submission)===undefined;
}
