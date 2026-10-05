import {mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {RBridgeExecutionReceiptV1,RBridgeExecutionPhase,RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionJournal,type RBridgeOperationRecordV1} from '../../src/server/rbridgeExecutionJournal.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
const roots=new Set<string>();
export async function cleanupRBridgeTestStates(){await Promise.all([...roots].map(root=>rm(root,{recursive:true,force:true})));roots.clear();}
export async function createRBridgeTestState(){
  const root=await mkdtemp(join(homedir(),'.rbridge-core-state-'));roots.add(root);
  const uid=process.getuid!(),binding={runtimeUid:uid,principalId:'operator',targetInstanceId:'aether'},serializer=createRBridgeOperationSerializer(),files=createRBridgeStateFiles({checkFilesystem:async()=>undefined}),policy=createRBridgeExecutionPolicy(binding);
  const context={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:binding.principalId} as const;
  const journal=await createRBridgeExecutionJournal({root,binding,serializer,files});
  function submission(operationId='read-1'):RBridgeOperationSubmissionV1{return {schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation:{kind:'HEALTH',action:'STATUS'}};}
  async function claim(operationId='read-1'){const s=submission(operationId);return serializer.run(operationId,()=>journal.claim({submission:s,decision:policy.evaluate(s),context}));}
  async function transition(record:RBridgeOperationRecordV1,phase:RBridgeExecutionPhase,patch:Partial<RBridgeExecutionReceiptV1>={}){
    const next:RBridgeOperationRecordV1={...record,revision:record.revision+1,receipt:{...record.receipt,...patch,phase,transitions:[...record.receipt.transitions,{phase,at:record.receipt.transitions.at(-1)!.at}]}};
    return serializer.run(record.submission.operationId,()=>journal.update(record.submission.operationId,record.revision,next));
  }
  async function running(operationId='read-1'){let record=await claim(operationId);for(const phase of ['AUTHORIZED','STARTING','RUNNING'] as const)record=await transition(record,phase);return record;}
  return {root,uid,binding,serializer,files,policy,journal,context,submission,claim,transition,running};
}
