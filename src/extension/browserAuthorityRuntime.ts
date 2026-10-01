import {
  acquireWriteLeader,activateCapture,createSendTransaction,markClicked,markFailedBeforeClick,markSendReady,markSendUncertain,
  markSentVerified,markWaitingResponse,persistSendIntent,prepareBinding,verifyBinding,
  type BrowserBindingControlV1,type BrowserTargetObservationV1,type RbridgeChatBindingReceiptV1,type SendPurpose,
} from '../domain/rbridgeChatCore.js';
import {BrowserAuthorityStoreV1,type BrowserAuthoritySnapshotV1,type BrowserAuthorityStateV1} from './browserAuthorityStore.js';
import type {DeliveryClickGuardV3} from '../browser/chatgptDeliveryAdapter.js';

export interface BrowserLiveTargetReaderV1{
  observe(binding:BrowserBindingControlV1):Promise<BrowserTargetObservationV1>;
}

export interface BrowserContentDriverV1{
  stagePrompt(tabId:number,text:string):Promise<{status:'STAGED_VERIFIED'|'ALREADY_PRESENT_IDEMPOTENT';utf8Bytes:number}>;
  startCapture(tabId:number,captureToken:string):Promise<{status:'ACTIVE'}>;
  stopCapture(tabId:number):Promise<{status:'OFF'}>;
  preflightSend(tabId:number):Promise<{status:'FOUND'|'NOT_FOUND'|'AMBIGUOUS'}>;
  clickSend(tabId:number,guard?:DeliveryClickGuardV3):Promise<
    |{outcome:'CLICKED'}
    |{outcome:'FAILED_BEFORE_CLICK';reason:string}
    |{outcome:'UNCERTAIN';reason:string}
  >;
}

export interface StageSendInputV1{
  sessionId:string;
  generation:string;
  attemptId:string;
  effectId:string;
  challenge:string;
  purpose:SendPurpose;
  text:string;
}

const encoder=new TextEncoder();
const UNRESOLVED=new Set(['PREPARING','READY_NOT_SENT','SEND_INTENT','CLICKED_UNVERIFIED','SENT_VERIFIED','WAITING_RESPONSE','UNCERTAIN']);
function fail(code:string):never{throw new Error(code);}

export class BrowserAuthorityRuntimeV1{
  private armedSend:{effectId:string;revision:number}|null=null;

  constructor(
    private readonly store:BrowserAuthorityStoreV1,
    private readonly targetReader:BrowserLiveTargetReaderV1,
    private readonly content:BrowserContentDriverV1,
  ){}

  async state():Promise<BrowserAuthoritySnapshotV1|null>{return await this.store.load();}

  async assertSnapshot(expected:BrowserAuthoritySnapshotV1):Promise<symbol>{
    const fence=this.store.mutationFence(),current=await this.store.load();
    if(this.store.mutationFence()!==fence||!current||current.revision!==expected.revision||current.sha256!==expected.sha256)fail('RBRIDGE_BROWSER_AUTHORITY_CHANGED');
    return fence;
  }

  assertAdmission(fence:symbol):void{
    if(this.store.mutationFence()!==fence)fail('RBRIDGE_BROWSER_AUTHORITY_CHANGED');
  }

  async assertLiveSnapshot(expected:BrowserAuthoritySnapshotV1,now=new Date()):Promise<symbol>{
    await this.assertSnapshot(expected);
    const {binding,leader,capture}=expected;
    if(!binding||binding.status!=='VERIFIED'||leader?.status!=='ACTIVE'||capture?.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    await this.ensureLiveCapture(binding.tabId,capture);
    await verifyBinding(binding,await this.targetReader.observe(binding),now);
    return await this.assertSnapshot(expected);
  }

  async prepareAndVerifyBinding(target:BrowserTargetObservationV1,now=new Date(),expected?:BrowserAuthoritySnapshotV1|null):Promise<{snapshot:BrowserAuthoritySnapshotV1;receipt:RbridgeChatBindingReceiptV1}>{
    const fence=this.store.mutationFence(),current=await this.store.load();this.checkExpected(current,expected,fence);
    if(current?.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    const prepared=prepareBinding(target,now),observed=await this.targetReader.observe(prepared);
    const verified=await verifyBinding(prepared,observed,now);
    this.checkExpected(current,expected,fence);
    const snapshot=await this.store.commit(current?.revision??0,{binding:verified.control,leader:null,capture:null,activeSend:null},now);
    return {snapshot,receipt:verified.receipt};
  }

  async acquireLeader(now=new Date(),expected?:BrowserAuthoritySnapshotV1):Promise<BrowserAuthoritySnapshotV1>{
    const fence=this.store.mutationFence(),current=await this.required();this.checkExpected(current,expected,fence);
    if(current.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    if(!current.binding)fail('RBRIDGE_BINDING_REQUIRED');
    const leader=acquireWriteLeader(current.binding,current.leader,now);
    return await this.store.commit(current.revision,{binding:current.binding,leader,capture:null,activeSend:null},now);
  }

  async finalizeBindingReceipt(now=new Date(),expected?:BrowserAuthoritySnapshotV1):Promise<{snapshot:BrowserAuthoritySnapshotV1;receipt:RbridgeChatBindingReceiptV1}>{
    const fence=this.store.mutationFence(),current=await this.required(),{binding,leader,capture}=current;this.checkExpected(current,expected,fence);
    if(current.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE'||leader.epoch<1||capture.epoch<1)fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    await this.ensureLiveCapture(binding.tabId,capture);
    const observed=await this.targetReader.observe(binding);
    const verified=await verifyBinding({...binding,writeLeaderEpoch:leader.epoch,captureEpoch:capture.epoch},observed,now);
    this.checkExpected(current,expected,fence);
    const snapshot=await this.store.commit(current.revision,{binding:verified.control,leader,capture,activeSend:current.activeSend},now);
    // A positive receipt is emitted only after the exact committed authority
    // has been observed from storage, with a final live target confirmation.
    const readback=await this.store.load();
    if(!readback||readback.revision!==snapshot.revision||readback.sha256!==snapshot.sha256)fail('RBRIDGE_BINDING_RECEIPT_READBACK_UNCERTAIN');
    await verifyBinding(verified.control,await this.targetReader.observe(verified.control),now);
    const preCaptureFence=this.store.mutationFence(),preCapture=await this.store.load();
    if(this.store.mutationFence()!==preCaptureFence||!preCapture||preCapture.revision!==snapshot.revision||preCapture.sha256!==snapshot.sha256)fail('RBRIDGE_BINDING_RECEIPT_READBACK_UNCERTAIN');
    await this.ensureLiveCapture(binding.tabId,capture);
    const finalFence=this.store.mutationFence(),finalReadback=await this.store.load();
    if(this.store.mutationFence()!==finalFence||!finalReadback||finalReadback.revision!==snapshot.revision||finalReadback.sha256!==snapshot.sha256)fail('RBRIDGE_BINDING_RECEIPT_READBACK_UNCERTAIN');
    return {snapshot:finalReadback,receipt:verified.receipt};
  }

  async activateCapture(now=new Date(),expected?:BrowserAuthoritySnapshotV1):Promise<BrowserAuthoritySnapshotV1>{
    const fence=this.store.mutationFence(),current=await this.required();this.checkExpected(current,expected,fence);
    if(current.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    if(!current.binding||!current.leader)fail('RBRIDGE_WRITE_LEADER_REQUIRED');
    const capture=activateCapture(current.binding,current.leader,current.capture,now);
    const captureToken='capture:'+capture.sessionId+':'+String(capture.epoch);
    const started=await this.content.startCapture(current.binding.tabId,captureToken);
    if(started.status!=='ACTIVE')fail('RBRIDGE_CAPTURE_RUNTIME_NOT_ACTIVE');
    try{
      this.checkExpected(current,expected,fence);
      return await this.store.commit(current.revision,{binding:current.binding,leader:current.leader,capture,activeSend:null},now);
    }catch(error){
      try{await this.content.stopCapture(current.binding.tabId);}catch{}
      throw error;
    }
  }

  async stageSend(input:StageSendInputV1,now=new Date(),expected?:BrowserAuthoritySnapshotV1):Promise<BrowserAuthoritySnapshotV1>{
    this.armedSend=null;
    const fence=this.store.mutationFence(),current=await this.required();this.checkExpected(current,expected,fence);
    const {binding,leader,capture}=current;
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    if(current.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    await this.ensureLiveCapture(binding.tabId,capture);
    const observed=await this.targetReader.observe(binding),fresh=await verifyBinding(binding,observed,now);
    this.checkExpected(current,expected,fence);
    const staged=await this.content.stagePrompt(fresh.control.tabId,input.text);
    const bytes=encoder.encode(input.text).byteLength;
    if(staged.utf8Bytes!==bytes)fail('RBRIDGE_COMPOSER_READBACK_MISMATCH');
    const preflight=await this.content.preflightSend(fresh.control.tabId);
    if(preflight.status==='AMBIGUOUS')fail('RBRIDGE_SEND_BUTTON_AMBIGUOUS');
    if(preflight.status!=='FOUND')fail('RBRIDGE_SEND_BUTTON_NOT_FOUND');
    let tx=createSendTransaction({...input,payloadUtf8Bytes:bytes},fresh.control,leader,capture,now);
    tx=markSendReady(tx);
    this.checkExpected(current,expected,fence);
    return await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:tx},now);
  }

  async persistSendIntentOnly(now=new Date(),expected?:BrowserAuthoritySnapshotV1):Promise<BrowserAuthoritySnapshotV1>{
    this.armedSend=null;
    const fence=this.store.mutationFence(),current=await this.required(),tx=current.activeSend,{binding,leader,capture}=current;this.checkExpected(current,expected,fence);
    if(!tx||tx.state!=='READY_NOT_SENT')fail('RBRIDGE_SEND_NOT_READY');
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    await this.ensureLiveCapture(binding.tabId,capture);
    const observed=await this.targetReader.observe(binding),fresh=await verifyBinding(binding,observed,now);
    const preflight=await this.content.preflightSend(fresh.control.tabId);
    if(preflight.status==='AMBIGUOUS')fail('RBRIDGE_SEND_BUTTON_AMBIGUOUS');
    if(preflight.status!=='FOUND')fail('RBRIDGE_SEND_BUTTON_NOT_FOUND');
    const intent=persistSendIntent(tx,now);
    this.checkExpected(current,expected,fence);
    const snapshot=await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:intent},now);
    this.armedSend={effectId:intent.effectId,revision:snapshot.revision};
    return snapshot;
  }

  async executePersistedSend(now=new Date(),options?:{guard:DeliveryClickGuardV3;beforeClick:()=>void;expected?:BrowserAuthoritySnapshotV1}):Promise<BrowserAuthoritySnapshotV1>{
    const fence=this.store.mutationFence(),current=await this.required(),tx=current.activeSend,{binding,leader,capture}=current;this.checkExpected(current,options?.expected,fence);
    if(!tx||tx.state!=='SEND_INTENT')fail('RBRIDGE_SEND_NOT_INTENT');
    const armed=this.armedSend;
    if(!armed||armed.effectId!==tx.effectId||armed.revision!==current.revision)fail('RBRIDGE_SEND_RECONCILE_REQUIRED');
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE'){
      this.armedSend=null;
      fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    }

    let fresh;
    try{
      await this.ensureLiveCapture(binding.tabId,capture);
      const observed=await this.targetReader.observe(binding);
      fresh=await verifyBinding(binding,observed,now);
      const preflight=await this.content.preflightSend(fresh.control.tabId);
      if(preflight.status!=='FOUND'){
        this.armedSend=null;
        const reason=preflight.status==='AMBIGUOUS'?'RBRIDGE_SEND_BUTTON_AMBIGUOUS':'RBRIDGE_SEND_BUTTON_NOT_FOUND';
        const failed=markFailedBeforeClick(tx,reason);
        return await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:failed},now);
      }
    }catch(error){
      this.armedSend=null;
      throw error;
    }

    let admission:symbol;
    try{admission=await this.assertSnapshot(current);}catch(error){this.armedSend=null;throw error;}
    this.armedSend=null;
    try{
      this.assertAdmission(admission);
      options?.beforeClick();
      const outcome=await this.content.clickSend(fresh.control.tabId,options?.guard);
      if(outcome.outcome==='FAILED_BEFORE_CLICK'){
        const failed=markFailedBeforeClick(tx,outcome.reason);
        return await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:failed},new Date());
      }
      if(outcome.outcome==='UNCERTAIN')throw new Error('SEND_UNCERTAIN');
      const clicked=markClicked(tx,new Date());
      return await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:clicked},new Date());
    }catch(error){
      const uncertain=markSendUncertain(tx,'SEND_UNCERTAIN');
      try{await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:uncertain},new Date());}catch{}
      throw error instanceof Error&&error.message==='SEND_UNCERTAIN'?error:new Error('SEND_UNCERTAIN');
    }
  }

  async sendOnce(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    await this.persistSendIntentOnly(now);
    return await this.executePersistedSend(now);
  }

  async markDeliveryVerified(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.required(),tx=current.activeSend;
    if(!tx)fail('RBRIDGE_SEND_ACTIVE_MISSING');
    const next=markSentVerified(tx,now);
    return await this.store.commit(current.revision,this.withSend(current,next),now);
  }

  async markObservedDeliveryVerified(expected:BrowserAuthoritySnapshotV1,now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    await this.assertSnapshot(expected);
    if(expected.activeSend?.state!=='CLICKED_UNVERIFIED')fail('RBRIDGE_SEND_OBSERVED_CLICK_REQUIRED');
    const binding=expected.binding,capture=expected.capture;
    if(!binding||!capture||capture.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    await this.ensureLiveCapture(binding.tabId,capture);
    await verifyBinding(binding,await this.targetReader.observe(binding),now);
    const admission=await this.assertSnapshot(expected);
    this.assertAdmission(admission);
    return await this.store.commit(expected.revision,this.withSend(expected,markSentVerified(expected.activeSend,now)),now);
  }

  async waitForResponse(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.required(),tx=current.activeSend;
    if(!tx)fail('RBRIDGE_SEND_ACTIVE_MISSING');
    const next=markWaitingResponse(tx);
    return await this.store.commit(current.revision,this.withSend(current,next),now);
  }

  private async ensureLiveCapture(tabId:number,capture:NonNullable<BrowserAuthoritySnapshotV1['capture']>):Promise<void>{
    const token='capture:'+capture.sessionId+':'+String(capture.epoch);
    const started=await this.content.startCapture(tabId,token);
    if(started.status!=='ACTIVE')fail('RBRIDGE_CAPTURE_RUNTIME_NOT_ACTIVE');
  }

  private async required():Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.store.load();if(!current)fail('RBRIDGE_BROWSER_AUTHORITY_STATE_MISSING');return current;
  }

  private checkExpected(current:BrowserAuthoritySnapshotV1|null,expected:BrowserAuthoritySnapshotV1|null|undefined,fence:symbol):void{
    if(expected===undefined)return;
    this.assertAdmission(fence);
    if(expected===null?current!==null:!current||current.revision!==expected.revision||current.sha256!==expected.sha256)fail('RBRIDGE_BROWSER_AUTHORITY_CHANGED');
  }

  private withSend(current:BrowserAuthoritySnapshotV1,activeSend:NonNullable<BrowserAuthoritySnapshotV1['activeSend']>):BrowserAuthorityStateV1{
    return {binding:current.binding,leader:current.leader,capture:current.capture,activeSend};
  }
}
