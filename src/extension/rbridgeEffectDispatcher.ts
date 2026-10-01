import {parseEffectCommand,type CocwinRbridgeEffectRequestV1,type EffectExecutionV3,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1} from '../domain/rbridgeEffectProtocol.js';
import {buildEffectResult,pendingEffectOutcome,RbridgeEffectStoreV1,snapshotEffectData} from './rbridgeEffectStore.js';

export class RbridgeEffectDispatcherV1{
  constructor(private readonly store:RbridgeEffectStoreV1,private readonly execute:(request:CocwinRbridgeEffectRequestV1)=>Promise<EffectExecutionV3>){}
  async dispatch(input:RbridgeChatEffectCommandV1):Promise<RbridgeChatEffectResultV1>{
    // dispatchOnce reserves the command identity synchronously. EXECUTE reserves
    // its arrival slot before any hash/storage await; RECONCILE bypasses that tail.
    return await this.store.dispatchOnce(input,command=>command.action==='RECONCILE'?this.dispatchOne(command):this.store.enqueueMutation(()=>this.dispatchOne(command)));
  }
  private async dispatchOne(snapshot:RbridgeChatEffectCommandV1):Promise<RbridgeChatEffectResultV1>{
    const command=await parseEffectCommand(snapshot,65536),reservation=await this.store.reserve(command),prior=await this.store.getCommand(command);
    if(prior?.result)return prior.result;
    const request=command.request;
    let outcome:EffectExecutionV3;
    if(command.action==='RECONCILE'||reservation==='REPLAY'){
      const observed=await this.store.read(request.effectId,request.requestDigest);
      outcome=observed?.outcome??{state:'BLOCKED',receipt:null,reason:'RBRIDGE_EFFECT_NOT_FOUND'};
    }else{
      // A concurrent RECONCILE/read can poison storage during the last await.
      // Keep this admission and the executor call in the same synchronous turn.
      this.store.assertMutationAvailable();
      try{outcome=snapshotEffectData(await this.execute(snapshotEffectData(request)));}
      catch{outcome=pendingEffectOutcome(request);}
    }
    let result:RbridgeChatEffectResultV1;
    try{result=await buildEffectResult(command,outcome);}catch{result=await buildEffectResult(command,pendingEffectOutcome(request));}
    await this.store.saveResult(result);return result;
  }
}
