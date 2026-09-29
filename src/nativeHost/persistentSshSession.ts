import {spawn} from 'node:child_process';
type Signals=NodeJS.Signals;
import {buildSshStdioLaunch,encodeStdioFrame,StdioFrameDecoder,type SshStdioLaunchConfig} from '../transport/sshStdio.js';

export type PersistentSshStateV1='STOPPED'|'CONNECTING'|'CONNECTED'|'BACKOFF';

export interface PersistentSshHooksV1{
  onConnected?:()=>void|Promise<void>;
  onMessage?:(value:unknown)=>void|Promise<void>;
  onDisconnected?:(code:number|null,signal:string|null)=>void|Promise<void>;
  onError?:(error:Error)=>void|Promise<void>;
}

export interface SshProcessHandleV1{
  write(data:Uint8Array):void;
  onData(listener:(chunk:Uint8Array)=>void):void;
  onClose(listener:(code:number|null,signal:string|null)=>void):void;
  onError(listener:(error:Error)=>void):void;
  kill():void;
}

export interface SshProcessFactoryV1{
  launch(config:SshStdioLaunchConfig):SshProcessHandleV1;
}

export interface ReconnectSchedulerV1{
  set(delayMs:number,fn:()=>void):unknown;
  clear(handle:unknown):void;
}

const BACKOFF_MS=Object.freeze([100,250,500,1000,2000,5000] as const);

function defaultFactory():SshProcessFactoryV1{
  return {
    launch(config){
      const launch=buildSshStdioLaunch(config);
      const child=spawn(launch.command,launch.args,{shell:false,stdio:['pipe','pipe','pipe']});
      return {
        write(data){child.stdin.write(data);},
        onData(listener){child.stdout.on('data',(chunk:Buffer)=>listener(new Uint8Array(chunk)));},
        onClose(listener){child.once('close',(code,signal)=>listener(code,signal));},
        onError(listener){child.once('error',listener);},
        kill(){child.kill('SIGTERM' as Signals);},
      };
    },
  };
}

function defaultScheduler():ReconnectSchedulerV1{
  return {
    set(delayMs,fn){return setTimeout(fn,delayMs);},
    clear(handle){clearTimeout(handle as NodeJS.Timeout);},
  };
}

export class PersistentSshStdioSessionV1{
  private desired=false;
  private process:SshProcessHandleV1|null=null;
  private reconnectHandle:unknown=null;
  private failures=0;
  private decoder=new StdioFrameDecoder();
  private _state:PersistentSshStateV1='STOPPED';

  constructor(
    private readonly config:SshStdioLaunchConfig,
    private readonly hooks:PersistentSshHooksV1={},
    private readonly factory:SshProcessFactoryV1=defaultFactory(),
    private readonly scheduler:ReconnectSchedulerV1=defaultScheduler(),
  ){}

  get state():PersistentSshStateV1{return this._state;}
  get failureCount():number{return this.failures;}

  start():void{
    if(this.desired)return;
    this.desired=true;
    this.connect();
  }

  markHealthy():void{this.failures=0;}

  send(value:unknown):boolean{
    if(this._state!=='CONNECTED'||!this.process)return false;
    this.process.write(encodeStdioFrame(value));
    return true;
  }

  stop():void{
    this.desired=false;
    if(this.reconnectHandle!==null){this.scheduler.clear(this.reconnectHandle);this.reconnectHandle=null;}
    const active=this.process;this.process=null;
    this._state='STOPPED';
    active?.kill();
  }

  private connect():void{
    if(!this.desired)return;
    this._state='CONNECTING';
    this.decoder=new StdioFrameDecoder();
    try{
      const child=this.factory.launch(this.config);
      this.process=child;
      this._state='CONNECTED';
      child.onData(chunk=>{
        try{
          for(const value of this.decoder.push(chunk))this.invoke(()=>this.hooks.onMessage?.(value));
          this.markHealthy();
        }catch(error){this.invokeError(error);}
      });
      child.onError(error=>this.invokeError(error));
      child.onClose((code,signal)=>this.handleClose(child,code,signal));
      this.invoke(()=>this.hooks.onConnected?.());
    }catch(error){
      this.process=null;
      this.invokeError(error);
      this.scheduleReconnect();
    }
  }

  private handleClose(child:SshProcessHandleV1,code:number|null,signal:string|null):void{
    if(this.process!==child)return;
    this.process=null;
    this.invoke(()=>this.hooks.onDisconnected?.(code,signal));
    if(!this.desired){this._state='STOPPED';return;}
    this.scheduleReconnect();
  }

  private scheduleReconnect():void{
    if(!this.desired)return;
    this.failures=Math.min(this.failures+1,BACKOFF_MS.length);
    const delay=BACKOFF_MS[Math.max(0,this.failures-1)]!;
    this._state='BACKOFF';
    if(this.reconnectHandle!==null)this.scheduler.clear(this.reconnectHandle);
    this.reconnectHandle=this.scheduler.set(delay,()=>{
      this.reconnectHandle=null;
      this.connect();
    });
  }

  private invoke(fn:()=>void|Promise<void>|undefined):void{
    try{
      const result=fn();
      if(result&&typeof (result as Promise<void>).then==='function')void (result as Promise<void>).catch(error=>this.invokeError(error));
    }catch(error){this.invokeError(error);}
  }

  private invokeError(error:unknown):void{
    const normalized=error instanceof Error?error:new Error(String(error));
    try{
      const result=this.hooks.onError?.(normalized);
      if(result&&typeof (result as Promise<void>).then==='function')void (result as Promise<void>).catch(()=>{});
    }catch{}
  }
}
