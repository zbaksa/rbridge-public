import {negotiateHello,parseHello,type NegotiatedHelloV1,type RbridgeChatEventV1,type RbridgeChatHelloV1,validateEventEnvelope} from '../domain/rbridgeChatCore.js';
import {parseRbridgeChatCommandResultV1,type RbridgeChatCommandResultV1,type RbridgeChatCommandV1} from '../domain/rbridgeChatCommand.js';
import {routeServerToNative} from '../nativeHost/nativeHostProtocol.js';

export const RBRIDGE_NATIVE_HOST_NAME='com.cocwin.rbridge_chat_v1';

export interface NativePortEventV1<T>{
  addListener(listener:(value:T)=>void):void;
}

export interface ExtensionNativePortV1{
  postMessage(value:unknown):void;
  disconnect():void;
  onMessage:NativePortEventV1<unknown>;
  onDisconnect:NativePortEventV1<void>;
}

export interface ExtensionRuntimeNativeApiV1{
  connectNative(name:string):ExtensionNativePortV1;
}

export interface ExtensionNativeLinkHooksV1{
  onServerHello?:(hello:RbridgeChatHelloV1,negotiated:NegotiatedHelloV1)=>void|Promise<void>;
  onServerCommand?:(command:RbridgeChatCommandV1)=>void|Promise<void>;
  onDisconnected?:()=>void|Promise<void>;
  onProtocolError?:(error:Error)=>void|Promise<void>;
}

function normalizeError(error:unknown):Error{return error instanceof Error?error:new Error(String(error));}

export class ExtensionNativePortLinkV1{
  private port:ExtensionNativePortV1|null=null;
  private negotiated:NegotiatedHelloV1|null=null;
  private readonly localHello:RbridgeChatHelloV1;

  constructor(
    private readonly runtime:ExtensionRuntimeNativeApiV1,
    hello:RbridgeChatHelloV1,
    private readonly hooks:ExtensionNativeLinkHooksV1={},
  ){
    this.localHello=parseHello(hello);
  }

  get connected():boolean{return this.port!==null;}
  get protocolReady():boolean{return this.port!==null&&this.negotiated!==null;}
  get negotiation():NegotiatedHelloV1|null{return this.negotiated?structuredClone(this.negotiated):null;}

  connect():void{
    if(this.port)return;
    this.negotiated=null;
    const port=this.runtime.connectNative(RBRIDGE_NATIVE_HOST_NAME);
    this.port=port;
    port.onMessage.addListener(value=>{void this.handleInbound(value);});
    port.onDisconnect.addListener(()=>{
      if(this.port===port){this.port=null;this.negotiated=null;}
      this.invoke(()=>this.hooks.onDisconnected?.());
    });
    port.postMessage(this.localHello);
  }

  disconnect():void{
    const port=this.port;this.port=null;this.negotiated=null;port?.disconnect();
  }

  async sendEvent(event:unknown):Promise<void>{
    const port=this.port;if(!port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    const validated:RbridgeChatEventV1=await validateEventEnvelope(event);
    port.postMessage(validated);
  }

  sendCommandResult(result:unknown):void{
    const port=this.port;if(!port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    const validated:RbridgeChatCommandResultV1=parseRbridgeChatCommandResultV1(result);
    port.postMessage(validated);
  }

  private async handleInbound(value:unknown):Promise<void>{
    try{
      const routed=routeServerToNative(value);
      if(routed.kind==='HELLO'){
        const negotiated=negotiateHello(this.localHello,routed.value);
        this.negotiated=negotiated;
        await this.hooks.onServerHello?.(routed.value,negotiated);
        return;
      }
      if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
      if(this.negotiated.protocolMinor>=1&&this.negotiated.capabilities.includes('CHAT_EFFECT_REQUEST_V1')&&routed.value.action!=='READ_STATE'&&routed.value.action!=='DISCOVER_TARGET')throw new Error('RBRIDGE_V1_MUTATION_DISABLED');
      await this.hooks.onServerCommand?.(routed.value);
    }catch(error){
      this.negotiated=null;
      await this.hooks.onProtocolError?.(normalizeError(error));
    }
  }

  private invoke(fn:()=>void|Promise<void>|undefined):void{
    try{
      const result=fn();
      if(result&&typeof (result as Promise<void>).then==='function')void (result as Promise<void>).catch(()=>{});
    }catch{}
  }
}
