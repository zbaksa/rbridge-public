import {parseHello,type RbridgeChatEventV1,type RbridgeChatHelloV1,validateEventEnvelope} from '../domain/rbridgeChatCore.js';
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
  onServerHello?:(hello:RbridgeChatHelloV1)=>void|Promise<void>;
  onDisconnected?:()=>void|Promise<void>;
  onProtocolError?:(error:Error)=>void|Promise<void>;
}

function normalizeError(error:unknown):Error{return error instanceof Error?error:new Error(String(error));}

export class ExtensionNativePortLinkV1{
  private port:ExtensionNativePortV1|null=null;

  constructor(
    private readonly runtime:ExtensionRuntimeNativeApiV1,
    private readonly hello:RbridgeChatHelloV1,
    private readonly hooks:ExtensionNativeLinkHooksV1={},
  ){}

  get connected():boolean{return this.port!==null;}

  connect():void{
    if(this.port)return;
    const port=this.runtime.connectNative(RBRIDGE_NATIVE_HOST_NAME);
    this.port=port;
    port.onMessage.addListener(value=>{void this.handleInbound(value);});
    port.onDisconnect.addListener(()=>{if(this.port===port)this.port=null;this.invoke(()=>this.hooks.onDisconnected?.());});
    port.postMessage(parseHello(this.hello));
  }

  disconnect():void{
    const port=this.port;this.port=null;port?.disconnect();
  }

  async sendEvent(event:unknown):Promise<void>{
    const port=this.port;if(!port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    const validated: RbridgeChatEventV1=await validateEventEnvelope(event);
    port.postMessage(validated);
  }

  private async handleInbound(value:unknown):Promise<void>{
    try{
      const routed=routeServerToNative(value);
      if(routed.kind==='HELLO')await this.hooks.onServerHello?.(routed.value);
    }catch(error){
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
