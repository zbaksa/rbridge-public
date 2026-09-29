import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  REQUIRED_RBRIDGE_CAPABILITIES,
  RbridgeEventSpoolV1,
} from '../src/domain/rbridgeChatCore.js';
import {NativeMessageDecoder,encodeNativeMessage} from '../src/transport/nativeMessaging.js';
import {StdioFrameDecoder,encodeStdioFrame} from '../src/transport/sshStdio.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {NativeHostRuntimeV1} from '../src/nativeHost/nativeHostRuntime.js';
import type {
  ReconnectSchedulerV1,
  SshProcessFactoryV1,
  SshProcessHandleV1,
} from '../src/nativeHost/persistentSshSession.js';

class FakeSshHandle implements SshProcessHandleV1 {
  writes:Uint8Array[]=[];
  killed=false;
  private dataListener:(chunk:Uint8Array)=>void=()=>{};
  private closeListener:(code:number|null,signal:string|null)=>void=()=>{};
  private errorListener:(error:Error)=>void=()=>{};

  write(data:Uint8Array):void{this.writes.push(data);}
  onData(listener:(chunk:Uint8Array)=>void):void{this.dataListener=listener;}
  onClose(listener:(code:number|null,signal:string|null)=>void):void{this.closeListener=listener;}
  onError(listener:(error:Error)=>void):void{this.errorListener=listener;}
  kill():void{this.killed=true;}
  emitData(data:Uint8Array):void{this.dataListener(data);}
  close(code:number|null=0,signal:string|null=null):void{this.closeListener(code,signal);}
  emitError(error:Error):void{this.errorListener(error);}
}

function sleep(ms=5):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}

export async function verifyNativeHostRuntimeFlow():Promise<void>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-native-runtime-'));
  const extensionId='a'.repeat(32);
  const origin='chrome-extension://'+extensionId+'/';
  const sessionId='exta-'+'a'.repeat(32);
  const generation='123e4567-e89b-42d3-a456-426614174000';
  const attemptId=sessionId+':a:1';
  const effectId='b'.repeat(64);
  const observedAt='2026-09-29T17:00:00.000Z';
  const receipt={
    schema:'COCWIN_RECEIPT_REF_V1' as const,
    receiptId:'runtime-receipt-1',
    receiptSchema:'RBRIDGE_TEST_RECEIPT_V1',
    sha256:'d'.repeat(64),
  };
  const hello={
    schema:'RBRIDGE_CHAT_HELLO_V1' as const,
    protocolMajor:1 as const,
    protocolMinor:3,
    releaseSha:'1'.repeat(40),
    maxMessageBytes:65536,
    capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],
    browserInstanceId:'chrome-main',
    browserProfileId:'profile-main',
    nativeHostVersion:'1.0.0',
  };

  const handles:FakeSshHandle[]=[];
  const factory:SshProcessFactoryV1={
    launch:()=>{const handle=new FakeSshHandle();handles.push(handle);return handle;},
  };
  const scheduled:Array<{delay:number;fn:()=>void;cancelled:boolean}>=[];
  const scheduler:ReconnectSchedulerV1={
    set:(delay,fn)=>{const row={delay,fn,cancelled:false};scheduled.push(row);return row;},
    clear:handle=>{(handle as {cancelled:boolean}).cancelled=true;},
  };
  const nativeOutput:Uint8Array[]=[];
  const transportErrors:string[]=[];
  const protocolErrors:string[]=[];

  const runtime=new NativeHostRuntimeV1(
    {
      expectedExtensionId:extensionId,
      eventStoreRoot:root,
      maxEvents:10,
      maxEventBytes:65536,
      ssh:{
        sshPath:'/usr/bin/ssh',
        host:'aether-engine',
        port:22,
        user:'rbridge',
        identityFile:'/home/rbridge/.ssh/id_ed25519',
        knownHostsFile:'/home/rbridge/.ssh/known_hosts',
      },
    },
    {write:data=>{nativeOutput.push(data);}},
    {
      onTransportError:error=>{transportErrors.push(error.message);},
      onProtocolError:error=>{protocolErrors.push(error.message);},
    },
    {processFactory:factory,scheduler},
  );

  try{
    const invocation=runtime.start([origin]);
    if(invocation.origin!==origin)throw new Error('NATIVE_RUNTIME_ORIGIN_MISMATCH');
    if(handles.length!==1)throw new Error('NATIVE_RUNTIME_SSH_NOT_STARTED');

    await runtime.acceptNativeChunk(encodeNativeMessage(hello));
    if(handles[0]!.writes.length!==1)throw new Error('NATIVE_RUNTIME_HELLO_NOT_FORWARDED');
    const sshDecode=new StdioFrameDecoder();
    const firstOutbound=sshDecode.push(handles[0]!.writes[0]!);
    if((firstOutbound[0] as {schema?:string})?.schema!=='RBRIDGE_CHAT_HELLO_V1')throw new Error('NATIVE_RUNTIME_HELLO_ORDER_INVALID');

    const spool=new RbridgeEventSpoolV1();
    const event=await spool.append({
      eventId:'runtime-event-1',
      eventType:'CAPTURE_ACTIVE',
      sessionId,
      generation,
      attemptId,
      effectId,
      observedAt,
      payload:{receipt},
    });
    await runtime.acceptNativeChunk(encodeNativeMessage(event));
    if(handles[0]!.writes.length!==1)throw new Error('NATIVE_RUNTIME_EVENT_SENT_BEFORE_NEGOTIATION');

    const reopened=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
    if((await reopened.load()).length!==1)throw new Error('NATIVE_RUNTIME_EVENT_NOT_DURABLE');

    handles[0]!.emitData(encodeStdioFrame({...hello,releaseSha:'2'.repeat(40)}));
    await sleep();
    if(!runtime.protocolReady)throw new Error('NATIVE_RUNTIME_PROTOCOL_NOT_READY');
    if(handles[0]!.writes.length!==2)throw new Error('NATIVE_RUNTIME_EVENT_NOT_REPLAYED');

    const replayDecode=new StdioFrameDecoder();
    const replayed=replayDecode.push(handles[0]!.writes[1]!);
    if((replayed[0] as {eventId?:string})?.eventId!=='runtime-event-1')throw new Error('NATIVE_RUNTIME_REPLAY_EVENT_INVALID');

    if(nativeOutput.length!==1)throw new Error('NATIVE_RUNTIME_SERVER_HELLO_NOT_RETURNED');
    const nativeDecode=new NativeMessageDecoder();
    const browserReply=nativeDecode.push(nativeOutput[0]!);
    if((browserReply[0] as {schema?:string})?.schema!=='RBRIDGE_CHAT_HELLO_V1')throw new Error('NATIVE_RUNTIME_BROWSER_HELLO_INVALID');

    handles[0]!.close(255,null);
    await sleep();
    if(runtime.protocolReady)throw new Error('NATIVE_RUNTIME_PROTOCOL_NOT_INVALIDATED_ON_CLOSE');
    if(scheduled.length<1||scheduled[0]!.delay!==100)throw new Error('NATIVE_RUNTIME_RECONNECT_NOT_SCHEDULED');

    scheduled[0]!.fn();
    await sleep();
    if(Number(handles.length)!==2)throw new Error('NATIVE_RUNTIME_RECONNECT_PROCESS_MISSING');
    if(handles[1]!.writes.length!==1)throw new Error('NATIVE_RUNTIME_RECONNECT_HELLO_NOT_FIRST');

    handles[1]!.emitData(encodeStdioFrame({...hello,releaseSha:'3'.repeat(40)}));
    await sleep();
    if(!runtime.protocolReady)throw new Error('NATIVE_RUNTIME_RECONNECT_NEGOTIATION_FAILED');
    if(Number(handles[1]!.writes.length)!==2)throw new Error('NATIVE_RUNTIME_RECONNECT_REPLAY_MISSING');
    if(Number(nativeOutput.length)!==2)throw new Error('NATIVE_RUNTIME_RECONNECT_BROWSER_HELLO_MISSING');

    runtime.stop();
    if(runtime.running)throw new Error('NATIVE_RUNTIME_STOP_FAILED');
    if(!handles[1]!.killed)throw new Error('NATIVE_RUNTIME_PROCESS_NOT_KILLED');
    if(transportErrors.length!==0||protocolErrors.length!==0)throw new Error('NATIVE_RUNTIME_UNEXPECTED_ERROR');
  }finally{
    runtime.stop();
    await rm(root,{recursive:true,force:true});
  }

  const invalidRoot=await mkdtemp(join(tmpdir(),'rbridge-native-runtime-invalid-'));
  try{
    const invalidHandles:FakeSshHandle[]=[];
    const invalidRuntime=new NativeHostRuntimeV1(
      {
        expectedExtensionId:extensionId,
        eventStoreRoot:invalidRoot,
        ssh:{
          sshPath:'/usr/bin/ssh',
          host:'aether-engine',
          port:22,
          user:'rbridge',
          identityFile:'/home/rbridge/.ssh/id_ed25519',
          knownHostsFile:'/home/rbridge/.ssh/known_hosts',
        },
      },
      {write:()=>{}},
      {},
      {processFactory:{launch:()=>{const handle=new FakeSshHandle();invalidHandles.push(handle);return handle;}},scheduler},
    );
    let denied=false;
    try{invalidRuntime.start(['chrome-extension://'+'b'.repeat(32)+'/']);}
    catch(error){denied=error instanceof Error&&error.message==='RBRIDGE_NATIVE_ORIGIN_DENIED';}
    if(!denied)throw new Error('NATIVE_RUNTIME_FOREIGN_ORIGIN_ACCEPTED');
    if(invalidHandles.length!==0)throw new Error('NATIVE_RUNTIME_SSH_STARTED_BEFORE_ORIGIN_VERIFY');
  }finally{
    await rm(invalidRoot,{recursive:true,force:true});
  }
}
