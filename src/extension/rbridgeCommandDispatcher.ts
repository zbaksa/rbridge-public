import {canonicalJson} from '../domain/rbridgeChatCore.js';
import {selectExactDiscoveredChatgptTarget,type ChromeTabsInventoryAdapterV1} from './chromeTabInventory.js';
import {BrowserAuthorityRuntimeV1} from './browserAuthorityRuntime.js';
import {
  buildCommandResultV1,commandBindTarget,commandErrorCode,parseRbridgeChatCommandV1,
  type RbridgeChatCommandResultV1,type RbridgeChatCommandV1,type StagePromptPayloadV1,
} from '../domain/rbridgeChatCommand.js';

function fail(code:string):never{throw new Error(code);}
function sameCorrelation(command:RbridgeChatCommandV1,state:Awaited<ReturnType<BrowserAuthorityRuntimeV1['state']>>):void{
  if(!state)fail('RBRIDGE_BROWSER_AUTHORITY_STATE_MISSING');
  if(state.binding&&(state.binding.sessionId!==command.sessionId||state.binding.generation!==command.generation))fail('STALE_GENERATION');
  if(command.attemptId!==null||command.effectId!==null){
    const send=state.activeSend;
    if(command.action==='STAGE_PROMPT'){
      if(send&&send.state!=='FAILED_BEFORE_CLICK'&&send.state!=='STOPPED'&&send.state!=='SUPERSEDED'&&send.state!=='RESPONSE_VERIFIED')fail('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
      return;
    }
    if(!send)fail('RBRIDGE_SEND_ACTIVE_MISSING');
    if(send.sessionId!==command.sessionId||send.generation!==command.generation||send.attemptId!==command.attemptId||send.effectId!==command.effectId)fail('RBRIDGE_COMMAND_CORRELATION_MISMATCH');
  }
}

export class RbridgeChatCommandDispatcherV1{
  private readonly completed=new Map<string,{requestDigest:string;commandFingerprint:string;result:RbridgeChatCommandResultV1}>();
  private readonly pending=new Map<string,{requestDigest:string;commandFingerprint:string;result:Promise<RbridgeChatCommandResultV1>}>();
  private tail:Promise<void>=Promise.resolve();

  constructor(
    private readonly runtime:BrowserAuthorityRuntimeV1,
    private readonly inventory:ChromeTabsInventoryAdapterV1,
    private readonly browserInstanceId:string,
    private readonly browserProfileId:string,
  ){}

  async execute(input:unknown,now=new Date()):Promise<RbridgeChatCommandResultV1>{
    const command=structuredClone(parseRbridgeChatCommandV1(input)),at=new Date(now.getTime());
    const commandFingerprint=canonicalJson(command);
    const prior=this.completed.get(command.commandId)??this.pending.get(command.commandId);
    if(prior){
      if(prior.requestDigest!==command.requestDigest||prior.commandFingerprint!==commandFingerprint)fail('REQUEST_ID_COLLISION');
      return structuredClone(await prior.result);
    }
    const readOnly=command.action==='READ_STATE'||command.action==='DISCOVER_TARGET';
    const invoke=()=>this.executeOne(command,at);
    const result=readOnly?invoke():this.tail.then(invoke);
    if(!readOnly)this.tail=result.then(()=>undefined,()=>undefined);
    this.pending.set(command.commandId,{requestDigest:command.requestDigest,commandFingerprint,result});
    try{
      const value=await result;
      this.completed.set(command.commandId,{requestDigest:command.requestDigest,commandFingerprint,result:structuredClone(value)});
      return structuredClone(value);
    }finally{
      this.pending.delete(command.commandId);
    }
  }

  private async executeOne(command:RbridgeChatCommandV1,now:Date):Promise<RbridgeChatCommandResultV1>{
    try{
      const value=await this.dispatch(command,now);
      return buildCommandResultV1(command,{ok:true,result:value},now);
    }catch(error){
      return buildCommandResultV1(command,{ok:false,errorCode:commandErrorCode(error)},now);
    }
  }

  private async dispatch(command:RbridgeChatCommandV1,now:Date):Promise<unknown>{
    if(command.action==='DISCOVER_TARGET'){
      const p=command.payload as {canonicalProjectId:string;conversationId:string};
      const rows=await this.inventory.discover();
      return selectExactDiscoveredChatgptTarget(rows,{
        browserInstanceId:this.browserInstanceId,browserProfileId:this.browserProfileId,
        canonicalProjectId:p.canonicalProjectId,conversationId:p.conversationId,
      });
    }
    if(command.action==='READ_STATE'){
      const state=await this.runtime.state();
      if(state?.binding&&(state.binding.sessionId!==command.sessionId||state.binding.generation!==command.generation))fail('STALE_GENERATION');
      return state;
    }
    if(command.action==='BIND_TARGET'){
      const target=commandBindTarget(command,this.browserInstanceId,this.browserProfileId);
      return await this.runtime.prepareAndVerifyBinding(target,now);
    }

    const state=await this.runtime.state();
    sameCorrelation(command,state);

    if(command.action==='ACQUIRE_WRITE_LEADER')return await this.runtime.acquireLeader(now);
    if(command.action==='ACTIVATE_CAPTURE')return await this.runtime.activateCapture(now);
    if(command.action==='STAGE_PROMPT'){
      const p=command.payload as unknown as StagePromptPayloadV1;
      return await this.runtime.stageSend({
        sessionId:command.sessionId,generation:command.generation,
        attemptId:command.attemptId!,effectId:command.effectId!,challenge:p.challenge,purpose:p.purpose,text:p.text,
      },now);
    }
    if(command.action==='PERSIST_SEND_INTENT')return await this.runtime.persistSendIntentOnly(now);
    if(command.action==='EXECUTE_PERSISTED_SEND')return await this.runtime.executePersistedSend(now);
    if(command.action==='MARK_DELIVERY_VERIFIED')return await this.runtime.markDeliveryVerified(now);
    if(command.action==='WAIT_RESPONSE')return await this.runtime.waitForResponse(now);
    fail('RBRIDGE_COMMAND_ACTION_INVALID');
  }
}
