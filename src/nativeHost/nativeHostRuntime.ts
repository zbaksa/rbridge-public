import {encodeNativeMessage,NativeMessageDecoder} from '../transport/nativeMessaging.js';
import type {SshStdioLaunchConfig} from '../transport/sshStdio.js';
import {RbridgeChatEventStoreV1} from '../server/rbridgeChatEventStore.js';
import {parseNativeHostInvocation,type NativeHostInvocationV1} from './nativeHostInvocation.js';
import {NativeHostRelayV1} from './nativeHostRelay.js';
import {
  PersistentSshStdioSessionV1,
  type ReconnectSchedulerV1,
  type SshProcessFactoryV1,
} from './persistentSshSession.js';

export interface NativeHostRuntimeConfigV1 {
  expectedExtensionId:string;
  eventStoreRoot:string;
  ssh:SshStdioLaunchConfig;
  maxEvents?:number;
  maxEventBytes?:number;
}

export interface NativeHostBinaryOutputV1 {
  write(data:Uint8Array):void;
}

export interface NativeHostRuntimeHooksV1 {
  onTransportError?:(error:Error)=>void|Promise<void>;
  onProtocolError?:(error:Error)=>void|Promise<void>;
}

export interface NativeHostRuntimeDependenciesV1 {
  processFactory?:SshProcessFactoryV1;
  scheduler?:ReconnectSchedulerV1;
}

function error(value:unknown):Error{return value instanceof Error?value:new Error(String(value));}

export class NativeHostRuntimeV1 {
  private readonly decoder=new NativeMessageDecoder();
  private readonly relay:NativeHostRelayV1;
  private readonly ssh:PersistentSshStdioSessionV1;
  private browserQueue:Promise<void>=Promise.resolve();
  private started=false;

  constructor(
    private readonly config:NativeHostRuntimeConfigV1,
    private readonly output:NativeHostBinaryOutputV1,
    private readonly hooks:NativeHostRuntimeHooksV1={},
    dependencies:NativeHostRuntimeDependenciesV1={},
  ){
    const store=new RbridgeChatEventStoreV1({
      root:config.eventStoreRoot,
      ...(config.maxEvents===undefined?{}:{maxEvents:config.maxEvents}),
      ...(config.maxEventBytes===undefined?{}:{maxBytes:config.maxEventBytes}),
    });

    const sessionRef:{current:PersistentSshStdioSessionV1|null}={current:null};
    this.relay=new NativeHostRelayV1(store,{
      send:async value=>{
        if(!sessionRef.current?.send(value)){
          this.relay.peerDisconnected();
          throw new Error('RBRIDGE_SSH_NOT_CONNECTED');
        }
      },
    });

    const session=new PersistentSshStdioSessionV1(
      config.ssh,
      {
        onConnected:async()=>{await this.relay.peerConnected();},
        onMessage:async value=>{
          try{
            const accepted=await this.relay.acceptServerMessage(value);
            this.output.write(encodeNativeMessage(accepted.message.value));
          }catch(cause){
            await this.invokeHook(this.hooks.onProtocolError,error(cause));
          }
        },
        onDisconnected:async()=>{this.relay.peerDisconnected();},
        onError:async cause=>{await this.invokeHook(this.hooks.onTransportError,cause);},
      },
      dependencies.processFactory,
      dependencies.scheduler,
    );
    sessionRef.current=session;
    this.ssh=session;
  }

  get running():boolean{return this.started;}
  get sshState(){return this.ssh.state;}
  get protocolReady():boolean{return this.relay.protocolReady;}

  start(chromeInvocationArgs:readonly string[]):NativeHostInvocationV1{
    if(this.started)throw new Error('RBRIDGE_NATIVE_HOST_ALREADY_STARTED');
    const invocation=parseNativeHostInvocation(chromeInvocationArgs,this.config.expectedExtensionId);
    this.started=true;
    this.ssh.start();
    return invocation;
  }

  async acceptNativeChunk(chunk:Uint8Array):Promise<void>{
    if(!this.started)throw new Error('RBRIDGE_NATIVE_HOST_NOT_STARTED');
    const messages=this.decoder.push(chunk);
    const work=this.browserQueue.then(async()=>{
      for(const message of messages)await this.relay.acceptBrowserMessage(message);
    });
    this.browserQueue=work.catch(()=>{});
    return await work;
  }

  stop():void{
    if(!this.started)return;
    this.started=false;
    this.relay.peerDisconnected();
    this.ssh.stop();
  }

  private async invokeHook(hook:((error:Error)=>void|Promise<void>)|undefined,cause:Error):Promise<void>{
    if(!hook)return;
    try{await hook(cause);}catch{}
  }
}
