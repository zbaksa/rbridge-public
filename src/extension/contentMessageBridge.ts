import {ChatgptContentRuntimeV1} from './contentRuntime.js';
import {canonicalJson} from '../domain/rbridgeEffectProtocol.js';
import {parseContentCaptureNotificationV3,type CaptureAckV3} from './rbridgeCaptureEgress.js';
import {snapshotEffectData} from './rbridgeEffectStore.js';

export interface ContentMessageEventV1{
  addListener(listener:(message:unknown,sender:unknown,sendResponse:(response:unknown)=>void)=>boolean|void):void;
}
export interface ContentMessageRuntimeApiV1{
  onMessage:ContentMessageEventV1;
}
export type ContentReplyV1=
  |{schema:'RBRIDGE_CONTENT_REPLY_V1';requestId:string;ok:true;result:unknown}
  |{schema:'RBRIDGE_CONTENT_REPLY_V1';requestId:string;ok:false;errorCode:string};

function code(error:unknown):string{
  const value=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(value)?value:'RBRIDGE_CONTENT_RUNTIME_ERROR';
}
function requestId(input:unknown):string{
  if(input&&typeof input==='object'&&!Array.isArray(input)){
    const value=(input as Record<string,unknown>).requestId;
    if(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value))return value;
  }
  return 'invalid';
}
export function installContentMessageBridgeV1(api:ContentMessageRuntimeApiV1,runtime:ChatgptContentRuntimeV1):void{
  api.onMessage.addListener((message,_sender,sendResponse)=>{
    const id=requestId(message);
    Promise.resolve().then(()=>runtime.handle(message)).then(
      result=>sendResponse({schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:id,ok:true,result} satisfies ContentReplyV1),
      error=>sendResponse({schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:id,ok:false,errorCode:code(error)} satisfies ContentReplyV1),
    );
    return true;
  });
}

// The observer may advance its baseline only after this notifier has a durable worker ack.
export class DurableCaptureNotifierV3{
  private readonly acknowledged=new Map<string,CaptureAckV3>();
  private readonly pending=new Map<string,Promise<CaptureAckV3>>();
  constructor(private readonly send:(notification:unknown)=>Promise<unknown>){}
  hasAcknowledged(input:unknown):boolean{return this.acknowledged.has(canonicalJson(parseContentCaptureNotificationV3(input)));}
  async notify(input:unknown):Promise<CaptureAckV3>{
    const notification=parseContentCaptureNotificationV3(input),key=canonicalJson(notification),prior=this.acknowledged.get(key);
    if(prior)return snapshotEffectData(prior);
    const pending=this.pending.get(key);if(pending)return snapshotEffectData(await pending);
    const work=Promise.resolve().then(async()=>{
      const value=snapshotEffectData(await this.send(notification));
      if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('RBRIDGE_CAPTURE_ACK_INVALID');
      const row=value as Record<string,unknown>;
      if(Object.keys(row).length!==3||Object.keys(row).some(name=>!['eventId','eventSha256','durable'].includes(name))||row.durable!==true||typeof row.eventId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.eventId)||typeof row.eventSha256!=='string'||!/^[0-9a-f]{64}$/.test(row.eventSha256))throw Error('RBRIDGE_CAPTURE_ACK_INVALID');
      const ack=row as unknown as CaptureAckV3;this.acknowledged.set(key,ack);return ack;
    });
    this.pending.set(key,work);
    try{return snapshotEffectData(await work);}finally{this.pending.delete(key);}
  }
}
