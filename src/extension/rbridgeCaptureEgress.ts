import {canonicalDigest,canonicalJson,sha256Hex,type CocwinRbridgeEffectRequestV1,type RbridgeChatEventV1} from '../domain/rbridgeEffectProtocol.js';
import {validateEventEnvelope} from '../domain/rbridgeChatCore.js';
import type {SiteMarkdownObservationV3} from '../browser/chatgptAssistantMarkdownCapture.js';
import type {BrowserAuthorityRuntimeV1} from './browserAuthorityRuntime.js';
import type {ChromeStorageAreaV1} from './browserAuthorityStore.js';
import {snapshotEffectData,type RbridgeEffectStoreV1} from './rbridgeEffectStore.js';

export interface ChromeCaptureSenderV3{id:string;tabId:number;frameId:number;url:string}
export interface CaptureAckV3{eventId:string;eventSha256:string;durable:true}
export interface ContentCaptureNotificationV3{
  schema:'RBRIDGE_CONTENT_CAPTURE_V3';captureToken:string;assistantTurnId:string;observation:SiteMarkdownObservationV3;
}
export interface CaptureEgressOptionsV3{
  storage:ChromeStorageAreaV1;runtime:BrowserAuthorityRuntimeV1;effects:RbridgeEffectStoreV1;
  extensionId:string;browserInstanceId:string;browserProfileId:string;ownerAppId:string;maxMessageBytes:number;
  initialHistory:readonly RbridgeChatEventV1[];publish:(event:RbridgeChatEventV1)=>Promise<void>;
}
export interface CaptureMessageApiV3{
  onMessage:{addListener(listener:(message:unknown,sender:unknown,respond:(reply:unknown)=>void)=>boolean|void):void};
}
interface Owner{extensionId:string;browserInstanceId:string;browserProfileId:string;ownerAppId:string;maxMessageBytes:number}
interface RecordV3{notificationDigest:string;requestDigest:string;captureToken:string;assistantTurnId:string;event:RbridgeChatEventV1}
interface Outbox{schema:'RBRIDGE_CAPTURE_OUTBOX_V3';owner:Owner;history:RbridgeChatEventV1[];records:RecordV3[];sha256:string}
interface Authority{queue:Promise<void>;poisoned:boolean;seen:Outbox|null}
const authorities=new WeakMap<ChromeStorageAreaV1,Authority>();
const KEY='rbridgeCaptureOutboxV3',LIMIT=8*1024*1024,MAX_EVENTS=4096;
const SHA=/^[0-9a-f]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const encoder=new TextEncoder();
function fail():never{throw Error('RBRIDGE_CAPTURE_REJECTED');}
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))fail();return value as Record<string,unknown>;}
function exact(row:Record<string,unknown>,keys:string[]):void{if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))fail();}
function id(value:unknown,max:number):string{if(typeof value!=='string'||!ID.test(value)||value.length>max)fail();return value;}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
function bytes(value:unknown):number{return encoder.encode(canonicalJson(value)).byteLength;}
function authority(storage:ChromeStorageAreaV1):Authority{
  let value=authorities.get(storage);if(!value){value={queue:Promise.resolve(),poisoned:false,seen:null};authorities.set(storage,value);}return value;
}
export function captureTokenV3(request:CocwinRbridgeEffectRequestV1,captureEpoch:number):string{
  if(!SHA.test(request.requestDigest)||!Number.isSafeInteger(captureEpoch)||captureEpoch<1)fail();
  return 'capture-v3:'+request.requestDigest+':'+String(captureEpoch);
}
export function parseContentCaptureNotificationV3(input:unknown):ContentCaptureNotificationV3{
  try{
    const row=object(snapshotEffectData(input));exact(row,['schema','captureToken','assistantTurnId','observation']);
    if(row.schema!=='RBRIDGE_CONTENT_CAPTURE_V3')fail();id(row.captureToken,192);id(row.assistantTurnId,256);
    const observation=object(row.observation);
    if(observation.kind==='CAPTURED'){
      exact(observation,['kind','assistantTurnId','markdown']);
      if(observation.assistantTurnId!==row.assistantTurnId||typeof observation.markdown!=='string')fail();
      // Bound intake independently of the much smaller accepted machine response.
      if(encoder.encode(observation.markdown).byteLength>4*1024*1024)fail();
    }else{exact(observation,['kind','reason']);if(observation.kind!=='UNAVAILABLE'||observation.reason!=='UI_PROTOCOL_CHANGED')fail();}
    return row as unknown as ContentCaptureNotificationV3;
  }catch{fail();}
}
function parseSender(input:ChromeCaptureSenderV3):ChromeCaptureSenderV3{
  const row=object(snapshotEffectData(input));exact(row,['id','tabId','frameId','url']);
  if(typeof row.id!=='string'||!/^[a-p]{32}$/.test(row.id)||!Number.isSafeInteger(row.tabId)||Number(row.tabId)<0||row.frameId!==0||typeof row.url!=='string')fail();
  return row as unknown as ChromeCaptureSenderV3;
}

export function installCaptureMessageBridgeV3(api:CaptureMessageApiV3,egress:RbridgeCaptureEgressV3|null):void{
  api.onMessage.addListener((message,sender,respond)=>{
    if(message===null||typeof message!=='object'||(message as Record<string,unknown>).schema!=='RBRIDGE_CONTENT_CAPTURE_V3')return false;
    let notification:ContentCaptureNotificationV3,source:ChromeCaptureSenderV3;
    try{
      notification=parseContentCaptureNotificationV3(message);
      const row=object(sender),tab=object(row.tab);
      source=parseSender({id:row.id,tabId:tab.id,frameId:row.frameId,url:row.url} as ChromeCaptureSenderV3);
    }catch{respond({errorCode:'RBRIDGE_CAPTURE_REJECTED'});return false;}
    if(!egress){respond({errorCode:'RBRIDGE_CAPTURE_V3_UNAVAILABLE'});return false;}
    void egress.accept(notification,source).then(ack=>{
      respond(ack);
      void egress.flush().catch(()=>{});
    },()=>respond({errorCode:'RBRIDGE_CAPTURE_REJECTED'}));
    return true;
  });
}

// One installed extension worker owns this chain. Native historical ownership is a separate upgrade gate.
export class RbridgeCaptureEgressV3{
  private readonly owner:Owner;
  private readonly history:RbridgeChatEventV1[];
  private readonly shared:Authority;
  constructor(private readonly options:CaptureEgressOptionsV3){
    this.owner=snapshotEffectData({extensionId:options.extensionId,browserInstanceId:options.browserInstanceId,browserProfileId:options.browserProfileId,ownerAppId:options.ownerAppId,maxMessageBytes:options.maxMessageBytes});
    if(!/^[a-p]{32}$/.test(this.owner.extensionId)||!Number.isSafeInteger(this.owner.maxMessageBytes)||this.owner.maxMessageBytes<4096||this.owner.maxMessageBytes>65536)fail();
    id(this.owner.browserInstanceId,128);id(this.owner.browserProfileId,128);id(this.owner.ownerAppId,192);
    this.history=snapshotEffectData([...options.initialHistory]);this.shared=authority(options.storage);
  }
  async accept(input:unknown,sender:ChromeCaptureSenderV3):Promise<CaptureAckV3>{
    // Both snapshots precede the first await and queue reservation.
    const notification=parseContentCaptureNotificationV3(input),source=parseSender(sender);
    return await this.exclusive(async()=>{
      const state=await this.options.runtime.state(),binding=state?.binding,tx=state?.activeSend,capture=state?.capture,leader=state?.leader;
      if(!state||binding?.status!=='VERIFIED'||capture?.status!=='ACTIVE'||leader?.status!=='ACTIVE'||!tx||!['SENT_VERIFIED','WAITING_RESPONSE'].includes(tx.state))fail();
      if(source.id!==this.owner.extensionId||source.tabId!==binding.tabId||binding.browserInstanceId!==this.owner.browserInstanceId||binding.browserProfileId!==this.owner.browserProfileId)fail();
      const url=new URL(source.url);
      if(url.origin!==binding.origin||url.pathname!=='/g/'+binding.projectId+'/c/'+binding.conversationId||url.search||url.hash||url.username||url.password)fail();
      const request=await this.options.effects.requestForEffect(tx.effectId);
      if(!request||(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND'))fail();
      const payload=request.payload,target=payload.target;
      if(request.sessionId!==tx.sessionId||request.generation!==tx.generation||request.attemptId!==tx.attemptId||request.effectId!==tx.effectId||payload.challenge!==tx.challenge||payload.purpose!==tx.purpose||notification.captureToken!==captureTokenV3(request,capture.epoch))fail();
      for(const key of ['browserInstanceId','browserProfileId','windowId','tabId','origin','projectId','conversationId','conversationGeneration'] as const)if(target[key]!==binding[key])fail();
      // The strict reserved request validates canonical project UUID separately from the URL slug.
      if(tx.conversationId!==binding.conversationId||tx.conversationGeneration!==binding.conversationGeneration||tx.captureEpoch!==capture.epoch||tx.writeLeaderEpoch!==leader.epoch||binding.sessionId!==request.sessionId||binding.generation!==request.generation||capture.sessionId!==request.sessionId||capture.generation!==request.generation)fail();
      const current=await this.load(),notificationDigest=await canonicalDigest(notification);
      const prior=current?.records.find(record=>record.captureToken===notification.captureToken&&record.assistantTurnId===notification.assistantTurnId);
      if(prior){if(prior.notificationDigest!==notificationDigest||prior.requestDigest!==request.requestDigest)fail();await this.options.runtime.assertLiveSnapshot(state);this.options.effects.assertMutationAvailable();return this.ack(prior.event);}
      const all=[...(current?.history??this.history),...(current?.records.map(record=>record.event)??[])];
      const identity=await canonicalDigest({requestDigest:request.requestDigest,captureToken:notification.captureToken,assistantTurnId:notification.assistantTurnId});
      const observedAt=new Date().toISOString();
      const envelope={schema:'RBRIDGE_CHAT_EVENT_V1' as const,eventId:'capture-event:'+identity,sequence:all.length+1,previousEventSha256:all.at(-1)?.eventSha256??null,sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,observedAt};
      const event=async(eventType:string,payload:RbridgeChatEventV1['payload']):Promise<RbridgeChatEventV1>=>{const body={...envelope,eventType,payload};return {...body,eventSha256:await canonicalDigest(body)};};
      let nextEvent:RbridgeChatEventV1;
      if(notification.observation.kind==='UNAVAILABLE')nextEvent=await event('CAPTURE_LOST',{reason:'UI_PROTOCOL_CHANGED'});
      else{
        const markdown=notification.observation.markdown,responseUtf8Bytes=encoder.encode(markdown).byteLength;
        const receiptBody={schema:'RBRIDGE_CHAT_CAPTURE_RECEIPT_V2' as const,receiptId:'capture-receipt:'+identity,sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,challenge:payload.challenge,conversationId:binding.conversationId,conversationGeneration:binding.conversationGeneration,assistantTurnId:notification.assistantTurnId,captureEncoding:'SITE_ASSISTANT_MARKDOWN_V1' as const,responseUtf8Bytes,assistantTurnSha256:await sha256Hex(markdown),captureEpoch:capture.epoch,observedAt};
        const receipt={...receiptBody,sha256:await canonicalDigest(receiptBody)};
        nextEvent=await event('ASSISTANT_TURN_CAPTURED_V2',{captureReceipt:{...receipt},assistantTurnUtf8:markdown});
        const reason=responseUtf8Bytes>16384?'MACHINE_RESPONSE_TOO_LARGE':bytes(nextEvent)>this.owner.maxMessageBytes?'OUTPUT_BUDGET_EXCEEDED':null;
        if(reason)nextEvent=await event('ASSISTANT_TURN_REJECTED_V2',{captureReceipt:{...receipt},reason});
      }
      await validateEventEnvelope(nextEvent);
      const records=[...(current?.records??[]),{notificationDigest,requestDigest:request.requestDigest,captureToken:notification.captureToken,assistantTurnId:notification.assistantTurnId,event:nextEvent}];
      const body={schema:'RBRIDGE_CAPTURE_OUTBOX_V3' as const,owner:this.owner,history:current?.history??this.history,records},next={...body,sha256:await canonicalDigest(body)};
      await this.validate(next);
      const fence=await this.options.runtime.assertLiveSnapshot(state);
      this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();
      try{
        await this.options.storage.set({[KEY]:snapshotEffectData(next)});
        const readback=await this.options.storage.get(KEY);if(!same(readback[KEY],next))fail();
        await this.validate(readback[KEY]);this.shared.seen=snapshotEffectData(next);
      }catch{this.shared.poisoned=true;fail();}
      return this.ack(nextEvent);
    }).catch(()=>fail());
  }
  async events():Promise<readonly RbridgeChatEventV1[]>{return await this.exclusive(async()=>snapshotEffectData((await this.load())?.records.map(record=>record.event)??[]));}
  async flush():Promise<void>{
    // Disconnects preserve every original event and its chain; posting is never a durable Native ack.
    const events=await this.events();
    for(const event of events){if(bytes(event)>this.owner.maxMessageBytes)break;try{await this.options.publish(snapshotEffectData(event));}catch{break;}}
  }
  private ack(event:RbridgeChatEventV1):CaptureAckV3{return {eventId:event.eventId,eventSha256:event.eventSha256,durable:true};}
  private exclusive<T>(run:()=>Promise<T>):Promise<T>{
    const result=this.shared.queue.then(()=>{if(this.shared.poisoned)fail();return run();});this.shared.queue=result.then(()=>undefined,()=>undefined);return result;
  }
  private async load():Promise<Outbox|null>{
    try{
      const value=(await this.options.storage.get(KEY))[KEY];if(value===undefined){if(this.shared.seen)fail();await this.validateHistory(this.history);return null;}
      const next=await this.validate(value),prior=this.shared.seen;
      if(prior&&(next.records.length<prior.records.length||!same(next.records.slice(0,prior.records.length),prior.records)))fail();
      this.shared.seen=snapshotEffectData(next);return next;
    }catch{this.shared.poisoned=true;fail();}
  }
  private async validateHistory(events:RbridgeChatEventV1[]):Promise<void>{
    if(events.length>MAX_EVENTS)fail();let previous:string|null=null;
    for(let i=0;i<events.length;i++){const event=await validateEventEnvelope(events[i]);if(event.sequence!==i+1||event.previousEventSha256!==previous)fail();previous=event.eventSha256;}
  }
  private async validate(value:unknown):Promise<Outbox>{
    const row=object(snapshotEffectData(value));exact(row,['schema','owner','history','records','sha256']);
    if(row.schema!=='RBRIDGE_CAPTURE_OUTBOX_V3'||!same(row.owner,this.owner)||!same(row.history,this.history)||!Array.isArray(row.history)||!Array.isArray(row.records)||typeof row.sha256!=='string'||!SHA.test(row.sha256)||row.history.length+row.records.length>MAX_EVENTS||bytes(row)>LIMIT)fail();
    const history=row.history as RbridgeChatEventV1[];await this.validateHistory(history);let previous=history.at(-1)?.eventSha256??null;
    const ids=new Set<string>(),keys=new Set<string>();
    for(let i=0;i<row.records.length;i++){
      const record=object(row.records[i]);exact(record,['notificationDigest','requestDigest','captureToken','assistantTurnId','event']);
      if(typeof record.notificationDigest!=='string'||!SHA.test(record.notificationDigest)||typeof record.requestDigest!=='string'||!SHA.test(record.requestDigest))fail();id(record.captureToken,192);id(record.assistantTurnId,256);
      const key=String(record.captureToken)+'/'+String(record.assistantTurnId),event=await validateEventEnvelope(record.event);
      if(event.sequence!==history.length+i+1||event.previousEventSha256!==previous||ids.has(event.eventId)||keys.has(key))fail();ids.add(event.eventId);keys.add(key);previous=event.eventSha256;
      if(!['CAPTURE_LOST','ASSISTANT_TURN_CAPTURED_V2','ASSISTANT_TURN_REJECTED_V2'].includes(event.eventType))fail();
      const identity=await canonicalDigest({requestDigest:record.requestDigest,captureToken:record.captureToken,assistantTurnId:record.assistantTurnId});
      if(event.eventId!=='capture-event:'+identity)fail();
      if(event.eventType!=='CAPTURE_LOST'){
        const receipt=object(event.payload.captureReceipt);
        if(receipt.receiptId!=='capture-receipt:'+identity||receipt.assistantTurnId!==record.assistantTurnId||record.captureToken!=='capture-v3:'+String(record.requestDigest)+':'+String(receipt.captureEpoch))fail();
        if(event.eventType==='ASSISTANT_TURN_CAPTURED_V2'&&bytes(event)>this.owner.maxMessageBytes)fail();
      }
    }
    const {sha256,...body}=row;if(await canonicalDigest(body)!==sha256)fail();return row as unknown as Outbox;
  }
}
