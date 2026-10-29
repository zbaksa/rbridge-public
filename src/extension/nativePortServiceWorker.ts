import {parseScopeQuiescenceQuery,parseWorkerQuiescenceReport,RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY,type RbridgeScopeQuiescenceQueryV1} from '../domain/rbridgeScopeQuiescence.js';
import {negotiateHello,parseHello,type NegotiatedHelloV1,type RbridgeChatEventV1,type RbridgeChatHelloV1,validateEventEnvelope} from '../domain/rbridgeChatCore.js';
import {parseRbridgeChatCommandResultV1,type RbridgeChatCommandResultV1,type RbridgeChatCommandV1} from '../domain/rbridgeChatCommand.js';
import {parseEffectResult,V3_CAPABILITIES,type RbridgeChatEffectCommandV1} from '../domain/rbridgeEffectProtocol.js';
import {routeServerToNative,routeServerToNativeV3,snapshotNativeMessage} from '../nativeHost/nativeHostProtocol.js';

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
  /** Transport only; the caller still supplies its authenticated scope/effect store. */
  onServerEffectCommand?:(command:RbridgeChatEffectCommandV1)=>void|Promise<void>;
  onServerScopeQuiescence?:(query:RbridgeScopeQuiescenceQueryV1)=>void|Promise<void>;
  onDisconnected?:()=>void|Promise<void>;
  onProtocolError?:(error:Error)=>void|Promise<void>;
}

function normalizeError(error:unknown):Error{return error instanceof Error?error:new Error(String(error));}

export class ExtensionNativePortLinkV1{
  private port:ExtensionNativePortV1|null=null;
  private negotiated:NegotiatedHelloV1|null=null;
  private v3Authority=false;
  private epoch=0;
  private v3ValidationTail:Promise<void>=Promise.resolve();
  private v3Pending=0;
  private handlerCount=0;
  private controlCount=0;
  private activitySequence=0;
  private readonly queryContexts=new WeakMap<RbridgeScopeQuiescenceQueryV1,{port:ExtensionNativePortV1;negotiated:NegotiatedHelloV1;epoch:number;query:RbridgeScopeQuiescenceQueryV1}>();
  private readonly effectContexts=new WeakMap<RbridgeChatEffectCommandV1,{port:ExtensionNativePortV1;negotiated:NegotiatedHelloV1;epoch:number;command:RbridgeChatEffectCommandV1}>();
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
    this.epoch++;
    this.negotiated=null;
    this.v3Authority=false;
    const port=this.runtime.connectNative(RBRIDGE_NATIVE_HOST_NAME);
    this.port=port;
    port.onMessage.addListener(value=>{void this.handleInbound(port,value);});
    port.onDisconnect.addListener(()=>{
      if(this.port!==port)return;
      this.epoch++;
      this.port=null;this.negotiated=null;this.v3Authority=false;
      this.invoke(()=>this.hooks.onDisconnected?.());
    });
    port.postMessage(this.localHello);
  }

  disconnect():void{
    this.epoch++;
    const port=this.port;this.port=null;this.negotiated=null;this.v3Authority=false;port?.disconnect();
  }

  async sendEvent(event:unknown):Promise<void>{
    const port=this.port;if(!port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    const negotiated=this.negotiated,epoch=this.epoch;
    const validated:RbridgeChatEventV1=await validateEventEnvelope(event);
    if(this.port!==port||this.negotiated!==negotiated||this.epoch!==epoch)throw new Error('RBRIDGE_PEER_CONNECTION_CHANGED');
    port.postMessage(validated);
  }

  sendCommandResult(result:unknown):void{
    const port=this.port;if(!port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    const validated:RbridgeChatCommandResultV1=parseRbridgeChatCommandResultV1(result);
    port.postMessage(validated);
  }

  admittedEffect(command:RbridgeChatEffectCommandV1):{command:RbridgeChatEffectCommandV1;assertCurrent:()=>void}{
    const context=this.effectContexts.get(command);
    if(!context)throw new Error('RBRIDGE_EFFECT_COMMAND_NOT_RECEIVED');
    const assertCurrent=()=>{
      if(this.port!==context.port||this.epoch!==context.epoch||this.negotiated!==context.negotiated)throw new Error('RBRIDGE_PEER_CONNECTION_CHANGED');
      this.requireV3(context.negotiated);
    };
    assertCurrent();
    return {command:structuredClone(context.command),assertCurrent};
  }

  async sendEffectResult(command:RbridgeChatEffectCommandV1,result:unknown):Promise<void>{
    if(!this.port)throw new Error('RBRIDGE_NATIVE_PORT_DISCONNECTED');
    if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    this.requireV3(this.negotiated);
    const context=this.effectContexts.get(command);
    if(!context)throw new Error('RBRIDGE_EFFECT_COMMAND_NOT_RECEIVED');
    const {port,negotiated,epoch}=context;
    if(this.port!==port||this.epoch!==epoch||this.negotiated!==negotiated)throw new Error('RBRIDGE_PEER_CONNECTION_CHANGED');
    const validated=await parseEffectResult(result,context.command,negotiated.maxMessageBytes);
    if(this.port!==port||this.epoch!==epoch||this.negotiated!==negotiated)throw new Error('RBRIDGE_PEER_CONNECTION_CHANGED');
    port.postMessage(validated);
  }

  admittedQuiescence(query:RbridgeScopeQuiescenceQueryV1):{query:RbridgeScopeQuiescenceQueryV1;assertCurrent:()=>void;pendingHandlers:()=>number;activityRevision:()=>number}{
    const context=this.queryContexts.get(query);if(!context)throw Error('RBRIDGE_SCOPE_QUERY_NOT_RECEIVED');
    const assertCurrent=()=>{if(this.port!==context.port||this.epoch!==context.epoch||this.negotiated!==context.negotiated)throw Error('RBRIDGE_PEER_CONNECTION_CHANGED');this.requireQuiescence(context.negotiated);};
    assertCurrent();return {query:structuredClone(context.query),assertCurrent,pendingHandlers:()=>this.handlerCount+Math.max(0,this.controlCount-1),activityRevision:()=>this.activitySequence};
  }
  async sendQuiescenceReport(original:RbridgeScopeQuiescenceQueryV1,input:unknown,finalAdmission:()=>void):Promise<void>{
    const context=this.queryContexts.get(original);if(!context)throw Error('RBRIDGE_SCOPE_QUERY_NOT_RECEIVED');
    const admission=this.admittedQuiescence(original),report=await parseWorkerQuiescenceReport(input,context.query);
    if(new TextEncoder().encode(JSON.stringify(report)).byteLength>context.negotiated.maxMessageBytes)throw Error('RBRIDGE_SCOPE_QUIESCENCE_BUDGET_EXCEEDED');
    admission.assertCurrent();finalAdmission();context.port.postMessage(report);
  }
  private requireQuiescence(negotiated:NegotiatedHelloV1):void{
    this.requireV3(negotiated);if(!negotiated.capabilities.includes(RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY))throw Error('RBRIDGE_SCOPE_QUIESCENCE_NOT_NEGOTIATED');
  }
  private receiveQuiescence(port:ExtensionNativePortV1,input:unknown,epoch:number):Promise<{pending:void|Promise<void>}|undefined>{
    const negotiated=this.negotiated;if(!negotiated)throw Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');this.requireQuiescence(negotiated);
    const handler=this.hooks.onServerScopeQuiescence;if(typeof handler!=='function')throw Error('RBRIDGE_SCOPE_QUIESCENCE_UNAVAILABLE');
    if(this.v3Pending>=128)throw Error('RBRIDGE_V3_BACKPRESSURE_EXCEEDED');
    const immutable=snapshotNativeMessage(input,negotiated.maxMessageBytes);this.v3Pending++;
    const current=()=>this.port===port&&this.epoch===epoch&&this.negotiated===negotiated;
    const work=this.v3ValidationTail.then(async()=>{
      try{if(!current())return;const query=await parseScopeQuiescenceQuery(immutable);if(!current())return;
        this.queryContexts.set(query,{port,negotiated,epoch,query:structuredClone(query)});return {pending:handler(query)};
      }catch(error){this.rejectProtocol(port,epoch,error);throw error;}finally{this.v3Pending--;}
    });
    this.v3ValidationTail=work.then(()=>undefined,()=>undefined);return work;
  }

  private requireV3(negotiated:NegotiatedHelloV1):void{
    if(negotiated.protocolMinor<1||V3_CAPABILITIES.some(cap=>!negotiated.capabilities.includes(cap)))throw new Error('RBRIDGE_V3_NOT_NEGOTIATED');
  }

  private receiveEffect(port:ExtensionNativePortV1,input:unknown,epoch:number):Promise<{pending:void|Promise<void>}|undefined>{
    const negotiated=this.negotiated;
    if(!negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
    this.requireV3(negotiated);
    const handler=this.hooks.onServerEffectCommand;
    if(typeof handler!=='function')throw new Error('RBRIDGE_V3_HANDLER_UNAVAILABLE');
    if(this.v3Pending>=128)throw new Error('RBRIDGE_V3_BACKPRESSURE_EXCEEDED');
    const inputSnapshot=snapshotNativeMessage(input,negotiated.maxMessageBytes);
    this.v3Pending++;
    const current=()=>this.port===port&&this.epoch===epoch&&this.negotiated===negotiated;
    const work=this.v3ValidationTail.then(async()=>{
      try{
        if(!current())return;
        const routed=await routeServerToNativeV3(inputSnapshot,negotiated.maxMessageBytes);
        if(!current())return;
        if(routed.kind!=='EFFECT_COMMAND')throw new Error('RBRIDGE_COMMAND_SCHEMA_DENIED');
        this.effectContexts.set(routed.value,{port,negotiated,epoch,command:structuredClone(routed.value)});
        // Reserve callback admission in arrival order, not browser completion.
        return {pending:handler(routed.value)};
      }catch(error){this.rejectProtocol(port,epoch,error);throw error;}
      finally{this.v3Pending--;}
    });
    this.v3ValidationTail=work.then(()=>undefined,()=>undefined);
    return work;
  }

  private rejectProtocol(port:ExtensionNativePortV1,epoch:number,error:unknown):void{
    if(this.port!==port||this.epoch!==epoch)return;
    this.negotiated=null;this.epoch++;
    this.invoke(()=>this.hooks.onProtocolError?.(normalizeError(error)));
  }

  private async handleInbound(port:ExtensionNativePortV1,value:unknown):Promise<void>{
    if(this.port!==port)return;
    let epoch=this.epoch,counted=false,control=false;
    try{
      const schema=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'schema'):undefined;
      if(schema&&!('value' in schema))throw new Error('RBRIDGE_NATIVE_INPUT_INVALID');
      if(schema?.value==='RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1'){
        control=true;this.controlCount++;if(this.controlCount>128)throw Error('RBRIDGE_V3_BACKPRESSURE_EXCEEDED');const dispatched=await this.receiveQuiescence(port,value,epoch);if(dispatched)await dispatched.pending;return;
      }
      if(this.handlerCount>=128)throw Error('RBRIDGE_V3_BACKPRESSURE_EXCEEDED');counted=true;this.handlerCount++;this.activitySequence++;
      if(schema?.value==='RBRIDGE_CHAT_EFFECT_COMMAND_V1'){
        const dispatched=await this.receiveEffect(port,value,epoch);
        if(dispatched)await dispatched.pending;
        return;
      }
      const routed=routeServerToNative(value);
      if(routed.kind==='HELLO'){
        const negotiated=negotiateHello(this.localHello,routed.value);
        const v3=negotiated.protocolMinor>=1&&negotiated.capabilities.includes('CHAT_EFFECT_REQUEST_V1');
        if(this.v3Authority&&!v3)throw new Error('RBRIDGE_V3_DOWNGRADE_DENIED');
        epoch=++this.epoch;
        this.v3Authority=this.v3Authority||v3;
        this.negotiated=negotiated;
        await this.hooks.onServerHello?.(routed.value,negotiated);
        return;
      }
      if(!this.negotiated)throw new Error('RBRIDGE_PROTOCOL_NOT_NEGOTIATED');
      if(this.negotiated.protocolMinor>=1&&this.negotiated.capabilities.includes('CHAT_EFFECT_REQUEST_V1')&&routed.value.action!=='READ_STATE'&&routed.value.action!=='DISCOVER_TARGET')throw new Error('RBRIDGE_V1_MUTATION_DISABLED');
      await this.hooks.onServerCommand?.(routed.value);
    }catch(error){
      this.rejectProtocol(port,epoch,error);
    }finally{if(counted)this.handlerCount--;if(control)this.controlCount--;}
  }

  private invoke(fn:()=>void|Promise<void>|undefined):void{
    try{
      const result=fn();
      if(result&&typeof (result as Promise<void>).then==='function')void (result as Promise<void>).catch(()=>{});
    }catch{}
  }
}
