import {negotiateHello,type NegotiatedHelloV1,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {RbridgeChatEventStoreV1} from '../server/rbridgeChatEventStore.js';
import {routeBrowserToNative,routeServerToNative,type ServerToNativeMessageV1} from './nativeHostProtocol.js';

export interface NativeHostPeerV1{
  send(value:RbridgeChatHelloV1|RbridgeChatEventV1):Promise<void>;
}

export type BrowserRelayResultV1=
  |'HELLO_CACHED'
  |'HELLO_FORWARDED'
  |'EVENT_DURABLE_QUEUED'
  |'EVENT_DURABLE_FORWARDED';

export interface ServerHelloResultV1{
  message:ServerToNativeMessageV1;
  negotiated:NegotiatedHelloV1;
  replayedEvents:number;
}

export class NativeHostRelayV1{
  private browserHello:RbridgeChatHelloV1|null=null;
  private transportConnected=false;
  private negotiated:NegotiatedHelloV1|null=null;

  constructor(
    private readonly store:RbridgeChatEventStoreV1,
    private readonly peer:NativeHostPeerV1,
  ){}

  get protocolReady():boolean{return this.transportConnected&&this.negotiated!==null;}

  async peerConnected():Promise<'WAITING_BROWSER_HELLO'|'HELLO_SENT'>{
    this.transportConnected=true;
    this.negotiated=null;
    if(!this.browserHello)return 'WAITING_BROWSER_HELLO';
    await this.peer.send(this.browserHello);
    return 'HELLO_SENT';
  }

  peerDisconnected():void{
    this.transportConnected=false;
    this.negotiated=null;
  }

  async acceptBrowserMessage(input:unknown):Promise<BrowserRelayResultV1>{
    const routed=await routeBrowserToNative(input);
    if(routed.kind==='HELLO'){
      this.browserHello=routed.value;
      this.negotiated=null;
      if(!this.transportConnected)return 'HELLO_CACHED';
      await this.peer.send(routed.value);
      return 'HELLO_FORWARDED';
    }
    if(!this.browserHello)throw new Error('RBRIDGE_BROWSER_HELLO_REQUIRED');
    await this.store.append(routed.value);
    if(!this.protocolReady)return 'EVENT_DURABLE_QUEUED';
    await this.peer.send(routed.value);
    return 'EVENT_DURABLE_FORWARDED';
  }

  async acceptServerMessage(input:unknown):Promise<ServerHelloResultV1>{
    if(!this.transportConnected)throw new Error('RBRIDGE_PEER_NOT_CONNECTED');
    if(!this.browserHello)throw new Error('RBRIDGE_BROWSER_HELLO_REQUIRED');
    this.negotiated=null;
    const message=routeServerToNative(input);
    const negotiated=negotiateHello(this.browserHello,message.value);
    this.negotiated=negotiated;
    try{
      const replayedEvents=await this.replayDurableEvents();
      return {message,negotiated,replayedEvents};
    }catch(error){
      this.negotiated=null;
      throw error;
    }
  }

  async replayDurableEvents():Promise<number>{
    if(!this.protocolReady)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    const events=await this.store.load();
    for(const event of events)await this.peer.send(event);
    return events.length;
  }
}
