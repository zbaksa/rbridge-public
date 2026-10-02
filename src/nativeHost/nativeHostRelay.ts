import {negotiateHello,type NegotiatedHelloV1,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import type {RbridgeChatCommandResultV1} from '../domain/rbridgeChatCommand.js';
import type {RbridgeChatEffectResultV1} from '../domain/rbridgeEffectProtocol.js';
import {RbridgeChatEventStoreV1} from '../server/rbridgeChatEventStore.js';
import {routeBrowserToNative,routeServerToNativeV3,snapshotNativeMessage,type ServerToNativeMessageV3} from './nativeHostProtocol.js';
import {NativeV3PeerAuthority} from './nativeV3PeerAuthority.js';
import {RbridgeEffectResultStoreV3} from './rbridgeEffectResultStore.js';

export interface NativeHostPeerV1{
  send(value:RbridgeChatHelloV1|RbridgeChatEventV1|RbridgeChatCommandResultV1|RbridgeChatEffectResultV1):Promise<void>;
}
export type BrowserRelayResultV1=
  |'HELLO_CACHED'|'HELLO_FORWARDED'|'EVENT_DURABLE_QUEUED'|'EVENT_DURABLE_FORWARDED'
  |'COMMAND_RESULT_FORWARDED'|'EFFECT_RESULT_DURABLE_QUEUED'|'EFFECT_RESULT_DURABLE_FORWARDED';
export interface ServerRelayResultV1{
  message:ServerToNativeMessageV3;negotiated:NegotiatedHelloV1;replayedEvents:number;replayedResults:number;
}
export interface NativeHostV3RelayOptions {results:RbridgeEffectResultStoreV3;authority:NativeV3PeerAuthority}
function isV3(hello:RbridgeChatHelloV1):boolean{return hello.capabilities.includes('CHAT_EFFECT_REQUEST_V1')||hello.capabilities.includes('CHAT_ASSISTANT_TURN_CAPTURE_V2');}

export class NativeHostRelayV1{
  private browserHello:RbridgeChatHelloV1|null=null;
  private transportConnected=false;
  private negotiated:NegotiatedHelloV1|null=null;
  private epoch=0;
  private queue:Promise<void>=Promise.resolve();
  constructor(private readonly store:RbridgeChatEventStoreV1,private readonly peer:NativeHostPeerV1,private readonly v3?:NativeHostV3RelayOptions){}
  get protocolReady():boolean{return this.transportConnected&&this.negotiated!==null;}
  private serial<T>(fn:()=>Promise<T>):Promise<T>{const work=this.queue.then(fn);this.queue=work.then(()=>{},()=>{});return work;}
  private async admit():Promise<void>{if(this.v3)await this.v3.authority.initialize(this.store,this.v3.results);}
  private current(epoch:number,negotiated?:NegotiatedHelloV1):void{
    if(epoch!==this.epoch||!this.transportConnected||(negotiated&&this.negotiated!==negotiated))throw Error('RBRIDGE_PEER_CONNECTION_CHANGED');
  }
  async peerConnected():Promise<'WAITING_BROWSER_HELLO'|'HELLO_SENT'>{
    const epoch=++this.epoch;this.transportConnected=true;this.negotiated=null;
    return this.serial(async()=>{
      await this.admit();this.current(epoch);
      if(!this.browserHello)return 'WAITING_BROWSER_HELLO';
      await this.peer.send(structuredClone(this.browserHello));this.current(epoch);return 'HELLO_SENT';
    });
  }
  peerDisconnected():void{this.epoch++;this.transportConnected=false;this.negotiated=null;}
  async acceptBrowserMessage(input:unknown):Promise<BrowserRelayResultV1>{
    const immutable=snapshotNativeMessage(input,this.v3?.authority.maxMessageBytes??65536);
    return this.serial(async()=>{
      await this.admit();
      if((immutable as {schema?:unknown})?.schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1'){
        if(!this.v3)throw Error('RBRIDGE_V3_NOT_CONFIGURED');
        if(!this.browserHello)throw Error('RBRIDGE_BROWSER_HELLO_REQUIRED');
        const result=await this.v3.results.recordRetained(immutable);
        if(!this.protocolReady)return 'EFFECT_RESULT_DURABLE_QUEUED';
        const epoch=this.epoch,negotiated=this.negotiated!;
        await this.peer.send(result);this.current(epoch,negotiated);return 'EFFECT_RESULT_DURABLE_FORWARDED';
      }
      const routed=await routeBrowserToNative(immutable);
      if(routed.kind==='HELLO'){
        this.negotiated=null;
        if(this.v3)this.v3.authority.validateHello(routed.value);
        else if(isV3(routed.value))throw Error('RBRIDGE_V3_NOT_CONFIGURED');
        this.browserHello=structuredClone(routed.value);
        if(!this.transportConnected)return 'HELLO_CACHED';
        const epoch=this.epoch;await this.peer.send(structuredClone(routed.value));this.current(epoch);return 'HELLO_FORWARDED';
      }
      if(!this.browserHello)throw Error('RBRIDGE_BROWSER_HELLO_REQUIRED');
      if(routed.kind==='COMMAND_RESULT'){
        if(!this.protocolReady)throw Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
        const epoch=this.epoch,negotiated=this.negotiated!;
        await this.peer.send(routed.value);this.current(epoch,negotiated);return 'COMMAND_RESULT_FORWARDED';
      }
      await this.store.append(routed.value);
      if(!this.protocolReady)return 'EVENT_DURABLE_QUEUED';
      const epoch=this.epoch,negotiated=this.negotiated!;
      await this.peer.send(routed.value);this.current(epoch,negotiated);return 'EVENT_DURABLE_FORWARDED';
    });
  }
  async acceptServerMessage(input:unknown):Promise<ServerRelayResultV1>{
    const immutable=snapshotNativeMessage(input,this.v3?.authority.maxMessageBytes??65536),epoch=this.epoch;
    return this.serial(async()=>{
      if(!this.transportConnected)throw Error('RBRIDGE_PEER_NOT_CONNECTED');this.current(epoch);
      if(!this.browserHello)throw Error('RBRIDGE_BROWSER_HELLO_REQUIRED');
      await this.admit();this.current(epoch);
      const message=await routeServerToNativeV3(immutable,this.v3?.authority.maxMessageBytes??65536);this.current(epoch);
      if(message.kind!=='HELLO'){
        const negotiated=this.negotiated;if(!negotiated)throw Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
        if(message.kind==='EFFECT_COMMAND'){
          if(!this.v3)throw Error('RBRIDGE_V3_NOT_CONFIGURED');
          this.v3.authority.validateTarget(message.value.request.payload.target);
          const command=await this.v3.results.reserve(message.value);this.current(epoch,negotiated);
          return {message:{kind:'EFFECT_COMMAND',value:command},negotiated:structuredClone(negotiated),replayedEvents:0,replayedResults:0};
        }
        if(this.v3&&message.value.action!=='READ_STATE'&&message.value.action!=='DISCOVER_TARGET')throw Error('RBRIDGE_V1_MUTATION_DISABLED');
        return {message,negotiated:structuredClone(negotiated),replayedEvents:0,replayedResults:0};
      }
      this.negotiated=null;
      if(this.v3)this.v3.authority.validateHello(message.value);
      else if(isV3(message.value))throw Error('RBRIDGE_V3_NOT_CONFIGURED');
      const negotiated=negotiateHello(this.browserHello,message.value);this.negotiated=negotiated;
      try{
        const replayedEvents=await this.replayEvents(epoch,negotiated);
        const results=this.v3?await this.v3.results.replay():[];this.current(epoch,negotiated);
        for(const result of results){this.current(epoch,negotiated);await this.peer.send(result);this.current(epoch,negotiated);}
        return {message,negotiated:structuredClone(negotiated),replayedEvents,replayedResults:results.length};
      }catch(error){this.negotiated=null;throw error;}
    });
  }
  private async replayEvents(epoch:number,negotiated:NegotiatedHelloV1):Promise<number>{
    const events=await this.store.load();this.current(epoch,negotiated);
    // Validate every original envelope before publishing any prefix. Oversize history remains intact and unavailable.
    for(const event of events)snapshotNativeMessage(event,negotiated.maxMessageBytes);
    for(const event of events){this.current(epoch,negotiated);await this.peer.send(event);this.current(epoch,negotiated);}
    return events.length;
  }
  replayDurableEvents():Promise<number>{
    return this.serial(async()=>{if(!this.protocolReady)throw Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');return this.replayEvents(this.epoch,this.negotiated!);});
  }
}
