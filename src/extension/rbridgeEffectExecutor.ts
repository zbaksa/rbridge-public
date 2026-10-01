import {canonicalDigest,canonicalJson,parseEffectRequest,type CocwinRbridgeEffectRequestV1,type EffectExecutionV3} from '../domain/rbridgeEffectProtocol.js';
import {projectSendReceipt,type BrowserTargetObservationV1} from '../domain/rbridgeChatCore.js';
import {ChatgptDeliveryAdapterV3} from '../browser/chatgptDeliveryAdapter.js';
import {ChatgptRolloverAdapterV3} from '../browser/chatgptRolloverAdapter.js';
import {BrowserAuthorityRuntimeV1} from './browserAuthorityRuntime.js';
import {RbridgeEffectStoreV1,snapshotEffectData} from './rbridgeEffectStore.js';
import type {BrowserAuthoritySnapshotV1} from './browserAuthorityStore.js';

function code(error:unknown):string{const value=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_:-]{0,127}$/.test(value)?value:'RBRIDGE_BROWSER_EFFECT_UNAVAILABLE';}
function target(request:CocwinRbridgeEffectRequestV1):BrowserTargetObservationV1{
  const {canonicalProjectId:_canonical,...t}=request.payload.target;void _canonical;return {...t,sessionId:request.sessionId,generation:request.generation,ownerSessionId:request.sessionId};
}
function assertSend(request:CocwinRbridgeEffectRequestV1,snapshot:BrowserAuthoritySnapshotV1,authority:BrowserAuthoritySnapshotV1):void{
  if(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND')throw Error('RBRIDGE_SEND_REQUIRED');
  const tx=snapshot.activeSend;if(!tx)throw Error('RBRIDGE_SEND_ACTIVE_MISSING');
  for(const key of ['sessionId','generation','attemptId','effectId'] as const)if(tx[key]!==request[key])throw Error('RBRIDGE_SEND_CORRELATION_CHANGED');
  if(tx.challenge!==request.payload.challenge||tx.purpose!==request.payload.purpose||tx.conversationId!==request.payload.target.conversationId||tx.conversationGeneration!==request.payload.target.conversationGeneration||tx.payloadUtf8Bytes!==new TextEncoder().encode(request.payload.text).byteLength||tx.writeLeaderEpoch!==authority.leader?.epoch||tx.captureEpoch!==authority.capture?.epoch)throw Error('RBRIDGE_SEND_CORRELATION_CHANGED');
}
export class BrowserEffectExecutorV3{
  private readonly claimed=new Set<string>();
  constructor(private readonly runtime:BrowserAuthorityRuntimeV1,private readonly effects:RbridgeEffectStoreV1,private readonly delivery:ChatgptDeliveryAdapterV3,private readonly rollover:ChatgptRolloverAdapterV3){this.rollover=rollover.withFinalAdmission(()=>this.effects.assertMutationAvailable());}
  async executeBrowserEffect(input:CocwinRbridgeEffectRequestV1):Promise<EffectExecutionV3>{
    const snapshot=snapshotEffectData(input);let clicking=false,request:CocwinRbridgeEffectRequestV1;
    try{
      request=await parseEffectRequest(snapshot,65536);
      const reserved=await this.effects.read(request.effectId,request.requestDigest);
      if(!reserved||reserved.result||canonicalJson(reserved.request)!==canonicalJson(request))throw Error('RBRIDGE_EFFECT_RESERVATION_REQUIRED');
      this.effects.assertMutationAvailable();if(this.claimed.has(request.effectId))throw Error('RBRIDGE_SEND_RECONCILE_REQUIRED');this.claimed.add(request.effectId);
      if(request.effectKind==='RBRIDGE_BIND'){
        const basis=await this.runtime.state(),prepared=await this.runtime.prepareAndVerifyBinding(target(request),new Date(),basis);
        const leader=await this.runtime.acquireLeader(new Date(),prepared.snapshot),capture=await this.runtime.activateCapture(new Date(),leader);
        return {state:'VERIFIED',receipt:(await this.runtime.finalizeBindingReceipt(new Date(),capture)).receipt,reason:null};
      }
      const current=await this.runtime.state(),binding=current?.binding;
      if(!current||!binding||binding.status!=='VERIFIED')throw Error('RBRIDGE_BINDING_REQUIRED');
      const expected=target(request);for(const key of Object.keys(expected) as (keyof BrowserTargetObservationV1)[])if(binding[key]!==expected[key])throw Error('BROWSER_BINDING_STALE');
      if(request.effectKind==='RBRIDGE_ROLLOVER'){
        const bindingReceipt=await this.rollover.createAndBindNextConversation(request.payload.target,request.payload.nextConversationGeneration);
        const body={schema:'RBRIDGE_CHAT_ROLLOVER_RECEIPT_V1' as const,receiptId:'rbridge-rollover:'+request.effectId,sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,requestDigest:request.requestDigest,previousConversationId:request.payload.target.conversationId,previousConversationGeneration:request.payload.target.conversationGeneration,bindingReceipt,observedAt:new Date().toISOString()};
        return {state:'VERIFIED',receipt:{...body,sha256:await canonicalDigest(body)},reason:null};
      }
      if(current.activeSend&&!['RESPONSE_VERIFIED','FAILED_BEFORE_CLICK','STOPPED','SUPERSEDED'].includes(current.activeSend.state))throw Error('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
      const guard=await this.delivery.prepareDelivery(request);await this.runtime.assertSnapshot(current);
      const staged=await this.runtime.stageSend({sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,challenge:request.payload.challenge,purpose:request.payload.purpose,text:request.payload.text},new Date(),current);
      assertSend(request,staged,current);
      const intent=await this.runtime.persistSendIntentOnly(new Date(),staged);assertSend(request,intent,current);clicking=true;
      const clicked=await this.runtime.executePersistedSend(new Date(),{guard,expected:intent,beforeClick:()=>{this.effects.assertMutationAvailable();this.delivery.assertAvailable();}});
      const tx=clicked.activeSend!;
      if(tx.state==='FAILED_BEFORE_CLICK')return {state:'FAILED_SAFE',receipt:await projectSendReceipt(tx),reason:tx.reason??'RBRIDGE_SEND_FAILED_BEFORE_CLICK'};
      for(const key of ['sessionId','generation','attemptId','effectId','challenge','purpose','conversationId','conversationGeneration','writeLeaderEpoch','captureEpoch'] as const)if(tx[key]!==staged.activeSend![key])throw Error('RBRIDGE_SEND_CORRELATION_CHANGED');
      assertSend(request,clicked,current);
      const observed=await this.delivery.observeExactDelivery(request);
      if(observed.kind!=='MATCHED')return {state:'UNCERTAIN',receipt:null,reason:'SEND_UNCERTAIN'};
      const verified=await this.runtime.markObservedDeliveryVerified(clicked);
      return {state:'VERIFIED',receipt:await projectSendReceipt(verified.activeSend!),reason:null};
    }catch(error){
      if(clicking||code(error)==='RBRIDGE_ROLLOVER_OUTCOME_UNCERTAIN')return {state:'UNCERTAIN',receipt:null,reason:clicking?'SEND_UNCERTAIN':'EXTERNAL_AGENT_EFFECT_OUTCOME_UNCERTAIN'};
      return {state:'BLOCKED',receipt:null,reason:code(error)};
    }
  }
}
