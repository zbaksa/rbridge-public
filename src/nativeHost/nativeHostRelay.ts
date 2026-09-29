import type {RbridgeChatEventV1,RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {RbridgeChatEventStoreV1} from '../server/rbridgeChatEventStore.js';
import {routeBrowserToNative,routeServerToNative,type ServerToNativeMessageV1} from './nativeHostProtocol.js';

export interface NativeHostPeerV1{
  send(value:RbridgeChatHelloV1|RbridgeChatEventV1):Promise<void>;
}

export class NativeHostRelayV1{
  constructor(
    private readonly store:RbridgeChatEventStoreV1,
    private readonly peer:NativeHostPeerV1,
  ){}

  async acceptBrowserMessage(input:unknown):Promise<'HELLO_FORWARDED'|'EVENT_DURABLE_FORWARDED'>{
    const routed=await routeBrowserToNative(input);
    if(routed.kind==='HELLO'){
      await this.peer.send(routed.value);
      return 'HELLO_FORWARDED';
    }
    await this.store.append(routed.value);
    await this.peer.send(routed.value);
    return 'EVENT_DURABLE_FORWARDED';
  }

  acceptServerMessage(input:unknown):ServerToNativeMessageV1{
    return routeServerToNative(input);
  }

  async replayDurableEvents():Promise<number>{
    const events=await this.store.load();
    for(const event of events)await this.peer.send(event);
    return events.length;
  }
}
