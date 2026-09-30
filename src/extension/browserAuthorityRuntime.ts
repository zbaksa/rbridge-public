import {
  acquireWriteLeader,activateCapture,createSendTransaction,markClicked,markFailedBeforeClick,markSendReady,markSendUncertain,
  markSentVerified,markWaitingResponse,persistSendIntent,prepareBinding,verifyBinding,
  type BrowserBindingControlV1,type BrowserTargetObservationV1,type RbridgeChatBindingReceiptV1,type SendPurpose,
} from '../domain/rbridgeChatCore.js';
import {BrowserAuthorityStoreV1,type BrowserAuthoritySnapshotV1,type BrowserAuthorityStateV1} from './browserAuthorityStore.js';

export interface BrowserLiveTargetReaderV1{
  observe(binding:BrowserBindingControlV1):Promise<BrowserTargetObservationV1>;
}

export interface BrowserContentDriverV1{
  stagePrompt(tabId:number,text:string):Promise<{status:'STAGED_VERIFIED'|'ALREADY_PRESENT_IDEMPOTENT';utf8Bytes:number}>;
  startCapture(tabId:number,captureToken:string):Promise<{status:'ACTIVE'}>;
  stopCapture(tabId:number):Promise<{status:'OFF'}>;
  preflightSend(tabId:number):Promise<{status:'FOUND'|'NOT_FOUND'|'AMBIGUOUS'}>;
  clickSend(tabId:number):Promise<
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

  async prepareAndVerifyBinding(target:BrowserTargetObservationV1,now=new Date()):Promise<{snapshot:BrowserAuthoritySnapshotV1;receipt:RbridgeChatBindingReceiptV1}>{
    const current=await this.store.load();
    if(current?.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    const prepared=prepareBinding(target,now),observed=await this.targetReader.observe(prepared);
    const verified=await verifyBinding(prepared,observed,now);
    const snapshot=await this.store.commit(current?.revision??0,{binding:verified.control,leader:null,capture:null,activeSend:null},now);
    return {snapshot,receipt:verified.receipt};
  }

  async acquireLeader(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.required();
    if(!current.binding)fail('RBRIDGE_BINDING_REQUIRED');
    const leader=acquireWriteLeader(current.binding,current.leader,now);
    return await this.store.commit(current.revision,{binding:current.binding,leader,capture:null,activeSend:null},now);
  }

  async activateCapture(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.required();
    if(!current.binding||!current.leader)fail('RBRIDGE_WRITE_LEADER_REQUIRED');
    const capture=activateCapture(current.binding,current.leader,current.capture,now);
    const captureToken='capture:'+capture.sessionId+':'+String(capture.epoch);
    const started=await this.content.startCapture(current.binding.tabId,captureToken);
    if(started.status!=='ACTIVE')fail('RBRIDGE_CAPTURE_RUNTIME_NOT_ACTIVE');
    try{
      return await this.store.commit(current.revision,{binding:current.binding,leader:current.leader,capture,activeSend:null},now);
    }catch(error){
      try{await this.content.stopCapture(current.binding.tabId);}catch{}
      throw error;
    }
  }

  async stageSend(input:StageSendInputV1,now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    this.armedSend=null;
    const current=await this.required();
    const {binding,leader,capture}=current;
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    if(current.activeSend&&UNRESOLVED.has(current.activeSend.state))fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    await this.ensureLiveCapture(binding.tabId,capture);
    const observed=await this.targetReader.observe(binding),fresh=await verifyBinding(binding,observed,now);
    const staged=await this.content.stagePrompt(fresh.control.tabId,input.text);
    const bytes=encoder.encode(input.text).byteLength;
    if(staged.utf8Bytes!==bytes)fail('RBRIDGE_COMPOSER_READBACK_MISMATCH');
    const preflight=await this.content.preflightSend(fresh.control.tabId);
    if(preflight.status==='AMBIGUOUS')fail('RBRIDGE_SEND_BUTTON_AMBIGUOUS');
    if(preflight.status!=='FOUND')fail('RBRIDGE_SEND_BUTTON_NOT_FOUND');
    let tx=createSendTransaction({...input,payloadUtf8Bytes:bytes},fresh.control,leader,capture,now);
    tx=markSendReady(tx);
    return await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:tx},now);
  }

  async persistSendIntentOnly(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    this.armedSend=null;
    const current=await this.required(),tx=current.activeSend,{binding,leader,capture}=current;
    if(!tx||tx.state!=='READY_NOT_SENT')fail('RBRIDGE_SEND_NOT_READY');
    if(!binding||binding.status!=='VERIFIED'||!leader||leader.status!=='ACTIVE'||!capture||capture.status!=='ACTIVE')fail('RBRIDGE_BROWSER_AUTHORITY_NOT_READY');
    await this.ensureLiveCapture(binding.tabId,capture);
    const observed=await this.targetReader.observe(binding),fresh=await verifyBinding(binding,observed,now);
    const preflight=await this.content.preflightSend(fresh.control.tabId);
    if(preflight.status==='AMBIGUOUS')fail('RBRIDGE_SEND_BUTTON_AMBIGUOUS');
    if(preflight.status!=='FOUND')fail('RBRIDGE_SEND_BUTTON_NOT_FOUND');
    const intent=persistSendIntent(tx,now);
    const snapshot=await this.store.commit(current.revision,{binding:fresh.control,leader,capture,activeSend:intent},now);
    this.armedSend={effectId:intent.effectId,revision:snapshot.revision};
    return snapshot;
  }

  async executePersistedSend(now=new Date()):Promise<BrowserAuthoritySnapshotV1>{
    const current=await this.required(),tx=current.activeSend,{binding,leader,capture}=current;
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

    this.armedSend=null;
    try{
      const outcome=await this.content.clickSend(fresh.control.tabId);
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

  private withSend(current:BrowserAuthoritySnapshotV1,activeSend:NonNullable<BrowserAuthoritySnapshotV1['activeSend']>):BrowserAuthorityStateV1{
    return {binding:current.binding,leader:current.leader,capture:current.capture,activeSend};
  }
}
