import {createHash} from 'node:crypto';
import type {RBridgeCoreCancellationResult,RBridgeCorePort,RBridgeCoreSubmitResult,RBridgeDeploymentBinding,RBridgeScope} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,assertRBridgeResultRange,canonicalRBridgeJson,parseRBridgeDeploymentBinding} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeExecutionPhase,type RBridgeExecutionReceiptV1,type RBridgeJsonValue,type RBridgeOperationSubmissionV1,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {parseRBridgePolicyDocument,parseRBridgeTransportContext,type RBridgeExecutionJournal,type RBridgeOperationRecordV1} from './rbridgeExecutionJournal.js';
import type {RBridgeExecutionResults} from './rbridgeExecutionResults.js';
import {evaluateRBridgePolicyDocument,freezeRBridgeValue,isRBridgePolicyRecoveryAllowed,type RBridgeExecutionPolicy} from './rbridgeExecutionPolicy.js';
import type {RBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
import type {RBridgeReadonlyHandler} from './rbridgeReadonlyHandlers.js';
export interface RBridgeExecutionCoreOptions{
  binding:RBridgeDeploymentBinding;subjects:{GITHUB:string;MCP:string;LOCAL?:string};journal:RBridgeExecutionJournal;results:RBridgeExecutionResults;policy:RBridgeExecutionPolicy;
  legacyReservations:{isReserved(id:string):Promise<boolean>};serializer:RBridgeOperationSerializer;handler:RBridgeReadonlyHandler;now?:()=>Date;
}
export type RBridgeExecutionCore=RBridgeCorePort&{recover():Promise<void>;close():Promise<void>};
function fail(code:string):never{throw new Error(code);}
function parseRBridgeOperationKey(value:string){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value))fail('RBRIDGE_CORE_OPERATION_ID_INVALID');}
const json=(value:unknown)=>canonicalRBridgeJson(value as RBridgeJsonValue);
export function createRBridgeExecutionCore(options:RBridgeExecutionCoreOptions):RBridgeExecutionCore{
  const binding=parseRBridgeDeploymentBinding(options.binding),current=parseRBridgePolicyDocument(options.policy.document);
  if(json(binding)!==json(current.binding)||options.subjects.MCP!==`uid:${binding.runtimeUid}`)fail('RBRIDGE_CORE_BINDING_INVALID');
  const subjects={...options.subjects};
  for(const [transport,authenticatedSubject] of Object.entries(subjects))parseRBridgeTransportContext({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport,authenticatedSubject,principalId:binding.principalId});
  const {journal,serializer,results,handler}=options,now=options.now??(()=>new Date());
  const queue=new Set<string>(),active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  const controls=new Map<string,Promise<void>>();
  const ingress=new Set<Promise<unknown>>();
  let closing=false,durabilityUnknown=false,wake:NodeJS.Immediate|undefined,closingPromise:Promise<void>|undefined,recoveryPromise:Promise<void>|undefined;
  function available(){if(closing)fail('RBRIDGE_CORE_CLOSED');if(durabilityUnknown)fail('RBRIDGE_CORE_DURABILITY_UNKNOWN');if(recoveryPromise)fail('RBRIDGE_CORE_RECOVERING');}
  function tracked<T>(invoke:()=>Promise<T>):Promise<T>{
    try{available();}catch(error){return Promise.reject(error);}
    const task=invoke();ingress.add(task);return task.finally(()=>{ingress.delete(task);});
  }
  function authorized(value:RBridgeTransportContextV1){
    const context=parseRBridgeTransportContext(value);
    if(context.principalId!==binding.principalId||subjects[context.transport]===undefined||subjects[context.transport]!==context.authenticatedSubject)fail('RBRIDGE_CORE_SCOPE_INVALID');
    return freezeRBridgeValue(context);
  }
  function scope(operationId:string):RBridgeScope{return {operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};}
  function receipt(record:RBridgeOperationRecordV1){return freezeRBridgeValue({status:'RECEIPT' as const,receipt:record.receipt});}
  function rejection(submission:RBridgeOperationSubmissionV1,reason:Extract<RBridgeCoreSubmitResult,{status:'REJECTED'}>['reason']):RBridgeCoreSubmitResult{return freezeRBridgeValue({status:'REJECTED',reason,operationId:submission.operationId,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId});}
  function stamp(record:RBridgeOperationRecordV1){const date=now(),ms=date.getTime();if(!Number.isFinite(ms))fail('RBRIDGE_CORE_TIME_INVALID');return new Date(Math.max(ms,Date.parse(record.receipt.transitions.at(-1)!.at))).toISOString();}
  async function transition(record:RBridgeOperationRecordV1,phase:RBridgeExecutionPhase,patch:Partial<RBridgeExecutionReceiptV1>={}){
    return journal.update(record.submission.operationId,record.revision,{...record,revision:record.revision+1,receipt:{...record.receipt,...patch,phase,transitions:[...record.receipt.transitions,{phase,at:stamp(record)}]}});
  }
  async function observe(record:RBridgeOperationRecordV1,context:RBridgeTransportContextV1){
    if(record.receipt.phase==='TERMINAL')return record;
    const old=record.observations[context.transport];if(old?.count===Number.MAX_SAFE_INTEGER)return record;
    return journal.update(record.submission.operationId,record.revision,{...record,revision:record.revision+1,observations:{...record.observations,[context.transport]:old?{...old,count:old.count+1}:{first:context,count:1}}});
  }
  async function cancelled(record:RBridgeOperationRecordV1){
    if(record.receipt.policy.decision==='BLOCK')return transition(record,'TERMINAL',{outcome:'BLOCKED',reason:record.receipt.policy.reason??'RBRIDGE_CORE_POLICY_BLOCKED'});
    if(record.receipt.phase==='CLAIMED')record=await transition(record,'AUTHORIZED');
    return transition(record,'TERMINAL',{outcome:'TERMINATED',reason:'RBRIDGE_CORE_CANCELLED_SETTLED',sideEffects:{state:'NONE_PROVEN'}});
  }
  function cancelQueued(id:string){
    queue.delete(id);if(controls.has(id))return;
    const task=new Promise<void>(done=>setImmediate(done)).then(()=>serializer.run(id,async()=>{const record=await journal.get(id);if(record&&record.receipt.phase!=='TERMINAL'&&record.receipt.cancellation.state==='REQUESTED')await cancelled(record);})).catch(()=>{durabilityUnknown=true;}).finally(()=>{controls.delete(id);pumpSoon();});
    controls.set(id,task);
  }
  async function cancelIntent(operationId:string,intentSha256:string,contextValue:RBridgeTransportContextV1,allowClosing=false):Promise<RBridgeCoreCancellationResult>{
    if(!allowClosing)available();parseRBridgeOperationKey(operationId);
    let context:RBridgeTransportContextV1;try{context=authorized(contextValue);}catch{return freezeRBridgeValue({status:'REJECTED',reason:'RBRIDGE_CORE_SCOPE_INVALID',...scope(operationId)});}
    void context;if(typeof intentSha256!=='string'||!/^[0-9a-f]{64}$/.test(intentSha256))fail('RBRIDGE_CORE_INTENT_INVALID');
    const result=await serializer.run(operationId,async():Promise<RBridgeCoreCancellationResult>=>{
      if(durabilityUnknown)fail('RBRIDGE_CORE_DURABILITY_UNKNOWN');let record=await journal.get(operationId);
      if(!record)return {status:'NOT_FOUND',...scope(operationId)};
      if(record.intentSha256!==intentSha256)return {status:'REJECTED',reason:'RBRIDGE_CORE_INTENT_COLLISION',...scope(operationId)};
      if(record.receipt.phase==='TERMINAL')return {status:'UNCHANGED_TERMINAL',receipt:record.receipt};
      if(record.receipt.cancellation.state!=='REQUESTED')record=await journal.update(operationId,record.revision,{...record,revision:record.revision+1,receipt:{...record.receipt,cancellation:{state:'REQUESTED',requestedAt:stamp(record)}}});
      return {status:'REQUESTED',receipt:record.receipt};
    });
    // Never signal inside the storage lease. An acknowledgement proves durable
    // intent only; the terminal transition waits for the handler to settle.
    if(result.status==='REQUESTED'){const running=active.get(operationId);if(running)running.controller.abort();else cancelQueued(operationId);}
    return freezeRBridgeValue(result);
  }
  function pumpSoon(){if(!wake&&!durabilityUnknown)wake=setImmediate(()=>{wake=undefined;pump();});}
  function pump(){
    while(!durabilityUnknown&&active.size<current.limits.handlers&&queue.size){
      const id=queue.values().next().value as string;queue.delete(id);const controller=new AbortController();
      const promise=run(id,controller.signal).catch(()=>{durabilityUnknown=true;}).finally(()=>{active.delete(id);pumpSoon();});
      active.set(id,{controller,promise});
    }
  }
  async function finishError(id:string,outcome:'FAIL'|'BLOCKED',reason:string){
    await serializer.run(id,async()=>{const record=await journal.get(id);if(record&&record.receipt.phase!=='TERMINAL'){if(record.receipt.cancellation.state==='REQUESTED')await cancelled(record);else await transition(record,'TERMINAL',{outcome,reason,sideEffects:{state:'NONE_PROVEN'}});}});
  }
  async function run(id:string,signal:AbortSignal){
    const dispatched=await serializer.run(id,async()=>{
      let record=await journal.get(id);if(!record)fail('RBRIDGE_CORE_RECORD_UNAVAILABLE');if(record.receipt.phase==='TERMINAL')return undefined;
      if(record.receipt.cancellation.state==='REQUESTED'){await cancelled(record);return undefined;}
      if(record.receipt.phase==='AUTHORIZED')record=await transition(record,'STARTING');
      if(record.receipt.phase==='STARTING')record=await transition(record,'RUNNING');
      if(record.receipt.phase!=='RUNNING')fail('RBRIDGE_CORE_DISPATCH_PHASE_INVALID');return record;
    });
    if(!dispatched)return;
    let output:RBridgeJsonValue;
    try{output=await handler.execute(dispatched.submission,dispatched.policyDocument,current,signal);assertBoundedRBridgeJson(output,{bytes:Math.min(dispatched.policyDocument.limits.outputBytes,current.limits.outputBytes),depth:Math.min(dispatched.policyDocument.limits.depth,current.limits.depth),nodes:Math.min(dispatched.policyDocument.limits.nodes,current.limits.nodes)});}
    catch(error){const reason=error instanceof Error?error.message:'';await finishError(id,reason==='RBRIDGE_READ_POLICY_BLOCKED'?'BLOCKED':'FAIL',reason.startsWith('RBRIDGE_READ_')&&/^[A-Z_]+$/.test(reason)?reason:'RBRIDGE_CORE_READ_FAILED');return;}
    await serializer.run(id,async()=>{
      const record=await journal.get(id);if(!record)fail('RBRIDGE_CORE_RECORD_UNAVAILABLE');if(record.receipt.phase==='TERMINAL')return;
      if(record.receipt.cancellation.state==='REQUESTED'){await cancelled(record);return;}
      let committed:{sha256:string;bytes:number};
      try{committed=await results.commit(id,output);}catch{await transition(record,'TERMINAL',{outcome:'FAIL',reason:'RBRIDGE_CORE_RESULT_COMMIT_FAILED',sideEffects:{state:'NONE_PROVEN'}});return;}
      await transition(record,'TERMINAL',{outcome:'PASS',resultSha256:committed.sha256,postconditions:[{name:'read-within-policy',status:'PASS',evidenceSha256:record.receipt.policy.policySha256},{name:'result-digest',status:'PASS',evidenceSha256:committed.sha256}],sideEffects:{state:'NONE_PROVEN'}});
    });
  }
  const port:RBridgeExecutionCore={
    async submit(value,contextValue,signal){
      available();assertBoundedRBridgeJson(value);const submission=freezeRBridgeValue(parseRBridgeOperationSubmissionV1(value));let context:RBridgeTransportContextV1;
      try{context=authorized(contextValue);if(submission.principalId!==binding.principalId||submission.targetInstanceId!==binding.targetInstanceId)fail('RBRIDGE_CORE_SCOPE_INVALID');}catch{return rejection(submission,'RBRIDGE_CORE_SCOPE_INVALID');}
      if(signal.aborted)fail('RBRIDGE_CORE_ABORTED');
      const result=await serializer.run(submission.operationId,async()=>{
        available();if(signal.aborted)fail('RBRIDGE_CORE_ABORTED');const existing=await journal.get(submission.operationId);
        if(existing){if(existing.intentSha256!==rbridgeOperationIntentDigest(submission))return rejection(submission,'RBRIDGE_CORE_INTENT_COLLISION');return receipt(await observe(existing,context));}
        if(await options.legacyReservations.isReserved(submission.operationId))return rejection(submission,'RBRIDGE_CORE_LEGACY_ID_RESERVED');
        const capacity=journal.capacity();if(capacity.nonterminal>=current.limits.nonterminal||capacity.identities>=current.limits.identities||!capacity.canClaim())return rejection(submission,'RBRIDGE_CORE_CAPACITY_REACHED');
        if(signal.aborted)fail('RBRIDGE_CORE_ABORTED');let record:RBridgeOperationRecordV1;
        try{record=await journal.claim({submission,context,decision:options.policy.evaluate(submission)});}catch(error){if(error instanceof Error&&error.message==='RBRIDGE_CORE_CAPACITY_REACHED')return rejection(submission,'RBRIDGE_CORE_CAPACITY_REACHED');throw error;}
        if(record.receipt.policy.decision==='BLOCK')return receipt(await transition(record,'TERMINAL',{outcome:'BLOCKED',reason:record.receipt.policy.reason??'RBRIDGE_CORE_POLICY_BLOCKED'}));
        record=await transition(record,'AUTHORIZED');queue.add(submission.operationId);pumpSoon();return receipt(record);
      });
      if(result.status==='RECEIPT'&&result.receipt.phase!=='TERMINAL'&&signal.aborted){const requested=await cancelIntent(submission.operationId,rbridgeOperationIntentDigest(submission),context,true);if(requested.status==='REQUESTED'||requested.status==='UNCHANGED_TERMINAL')return freezeRBridgeValue({status:'RECEIPT',receipt:requested.receipt});}
      return result;
    },
    async status(operationId,context){authorized(context);parseRBridgeOperationKey(operationId);return serializer.run(operationId,async()=>{if(durabilityUnknown)fail('RBRIDGE_CORE_DURABILITY_UNKNOWN');const record=await journal.get(operationId);return record?receipt(record):freezeRBridgeValue({status:'NOT_FOUND' as const,...scope(operationId)});});},
    async result(operationId,cursor,maxBytes,context){authorized(context);parseRBridgeOperationKey(operationId);assertRBridgeResultRange(cursor,maxBytes);return serializer.run(operationId,async()=>{if(durabilityUnknown)fail('RBRIDGE_CORE_DURABILITY_UNKNOWN');const record=await journal.get(operationId);return record?freezeRBridgeValue(await results.page(record,cursor,maxBytes)):freezeRBridgeValue({status:'NOT_FOUND' as const,...scope(operationId)});});},
    requestCancel:(operationId,intentSha256,context)=>cancelIntent(operationId,intentSha256,context),
    recover(){
      if(recoveryPromise)return recoveryPromise;available();if(active.size||queue.size||controls.size)fail('RBRIDGE_CORE_RECOVERY_WHILE_ACTIVE');
      recoveryPromise=(async()=>{
        const incomplete=await journal.recover();
        for(const previous of incomplete)await serializer.run(previous.submission.operationId,async()=>{
          let record=await journal.get(previous.submission.operationId);if(!record||record.receipt.phase==='TERMINAL')return;
          if(record.receipt.policy.decision==='BLOCK'){await transition(record,'TERMINAL',{outcome:'BLOCKED',reason:record.receipt.policy.reason??'RBRIDGE_CORE_POLICY_BLOCKED'});return;}
          if(record.receipt.phase==='CLAIMED')record=await transition(record,'AUTHORIZED');
          if(record.receipt.cancellation.state==='REQUESTED'){await cancelled(record);return;}
          if(!isRBridgePolicyRecoveryAllowed(record.policyDocument,current,record.submission)){
            const decision=evaluateRBridgePolicyDocument(current,record.submission),evidenceSha256=createHash('sha256').update(json(decision.snapshot)).digest('hex');
            await transition(record,'TERMINAL',{outcome:'BLOCKED',reason:'RBRIDGE_CORE_CURRENT_POLICY_RESTRICTED',postconditions:[{name:'current-policy-restriction',status:'PASS',evidenceSha256}]});return;
          }
          queue.add(record.submission.operationId);
        });
      })().catch(error=>{durabilityUnknown=true;throw error;}).finally(()=>{recoveryPromise=undefined;pumpSoon();});return recoveryPromise;
    },
    close(){
      if(!closingPromise){
        closing=true;
        closingPromise=(async()=>{
          if(recoveryPromise)await recoveryPromise;
          while(ingress.size||active.size||queue.size||controls.size||wake){
            if(durabilityUnknown){if(wake){clearImmediate(wake);wake=undefined;}queue.clear();}else pump();
            if(ingress.size||active.size||controls.size)await Promise.allSettled([...ingress,...[...active.values()].map(task=>task.promise),...controls.values()]);
            else if(wake)await new Promise<void>(done=>setImmediate(done));
          }
          if(durabilityUnknown)fail('RBRIDGE_CORE_DURABILITY_UNKNOWN');
        })();
      }
      return closingPromise;
    },
  };
  return {
    submit:(...args)=>tracked(()=>port.submit(...args)),status:(...args)=>tracked(()=>port.status(...args)),result:(...args)=>tracked(()=>port.result(...args)),requestCancel:(...args)=>tracked(()=>port.requestCancel(...args)),recover:port.recover,close:port.close,
  };
}
