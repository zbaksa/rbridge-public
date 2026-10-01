import {canonicalJson,type ExactBrowserTargetV1,type RbridgeChatBindingReceiptV1} from '../domain/rbridgeEffectProtocol.js';
import {BrowserAuthorityRuntimeV1} from '../extension/browserAuthorityRuntime.js';

export interface ChatgptRolloverDriverV3{
  available():boolean;
  quiescent(target:ExactBrowserTargetV1):Promise<boolean>;
  createNext(target:ExactBrowserTargetV1,nextConversationGeneration:number):Promise<ExactBrowserTargetV1>;
}
// No site creation route is advertised before real Task 11 feasibility proof.
export class UnavailableChatgptRolloverDriverV3 implements ChatgptRolloverDriverV3{
  available():boolean{return false;}
  async quiescent():Promise<boolean>{return false;}
  async createNext():Promise<ExactBrowserTargetV1>{throw Error('RBRIDGE_ROLLOVER_UNAVAILABLE');}
}
export class ChatgptRolloverAdapterV3{
  constructor(private readonly runtime:BrowserAuthorityRuntimeV1,private readonly driver:ChatgptRolloverDriverV3){}
  async createAndBindNextConversation(target:ExactBrowserTargetV1,nextConversationGeneration:number):Promise<RbridgeChatBindingReceiptV1>{
    if(!Number.isInteger(nextConversationGeneration)||nextConversationGeneration!==target.conversationGeneration+1||nextConversationGeneration>2147483647)throw Error('RBRIDGE_ROLLOVER_GENERATION_INVALID');
    const snapshot=await this.runtime.state(),binding=snapshot?.binding;
    if(!snapshot||!binding||binding.status!=='VERIFIED'||snapshot.activeSend&&!['RESPONSE_VERIFIED','FAILED_BEFORE_CLICK','STOPPED','SUPERSEDED'].includes(snapshot.activeSend.state))throw Error('RBRIDGE_SEND_ACTIVE_UNRESOLVED');
    if(!this.driver.available())throw Error('RBRIDGE_ROLLOVER_UNAVAILABLE');
    if(!await this.driver.quiescent(target))throw Error('RBRIDGE_ROLLOVER_NOT_QUIESCENT');
    await this.runtime.assertSnapshot(snapshot);
    let next:ExactBrowserTargetV1;
    try{
      next=await this.driver.createNext(JSON.parse(canonicalJson(target)) as ExactBrowserTargetV1,nextConversationGeneration);
      if(Object.keys(next).length!==Object.keys(target).length||Object.keys(next).some(key=>!(key in target)))throw Error('RBRIDGE_ROLLOVER_TARGET_INVALID');
      for(const key of ['browserInstanceId','browserProfileId','windowId','tabId','origin','canonicalProjectId','projectId'] as const)if(next[key]!==target[key])throw Error('BROWSER_BINDING_STALE');
      if(!next.conversationId||next.conversationId===target.conversationId||next.conversationGeneration!==nextConversationGeneration)throw Error('RBRIDGE_ROLLOVER_TARGET_INVALID');
      if(!await this.driver.quiescent(next))throw Error('RBRIDGE_ROLLOVER_NOT_QUIESCENT');
      await this.runtime.assertSnapshot(snapshot);
      const {canonicalProjectId:_canonical,...observed}=next;
      await this.runtime.prepareAndVerifyBinding({...observed,sessionId:binding.sessionId,generation:binding.generation,ownerSessionId:binding.ownerSessionId});
      await this.runtime.acquireLeader();await this.runtime.activateCapture();
      return (await this.runtime.finalizeBindingReceipt()).receipt;
    }catch{throw Error('RBRIDGE_ROLLOVER_OUTCOME_UNCERTAIN');}
  }
}
