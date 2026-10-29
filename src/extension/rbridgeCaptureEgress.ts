import {canonicalDigest,canonicalJson,sha256Hex,type CocwinRbridgeEffectRequestV1,type RbridgeChatEventV1,type V3Scope} from '../domain/rbridgeEffectProtocol.js';
import {validateEventEnvelope} from '../domain/rbridgeChatCore.js';
import type {SiteMarkdownObservationV3} from '../browser/chatgptAssistantMarkdownCapture.js';
import type {BrowserAuthorityRuntimeV1} from './browserAuthorityRuntime.js';
import type {BrowserAuthoritySnapshotV1,ChromeStorageAreaV1} from './browserAuthorityStore.js';
import {snapshotEffectData,type RbridgeEffectStoreV1} from './rbridgeEffectStore.js';
import type {SiteMarkdownReaderV3,SiteCaptureWorkV1,SiteMarkdownReadResultV3} from './chromeAuthorityAdapters.js';
import {SiteCaptureActivityStoreV1,type SiteCaptureActivityFactsV1,type SiteCaptureRawOutcomeV1} from './siteCaptureActivityStore.js';
import type {ChatgptDeliveryAdapterV3} from '../browser/chatgptDeliveryAdapter.js';

export interface ChromeCaptureSenderV3{id:string;tabId:number;frameId:number;url:string}
export interface CaptureAckV3{eventId:string;eventSha256:string;durable:true}
export interface ContentCaptureNotificationV3{
  schema:'RBRIDGE_CONTENT_CAPTURE_V3';captureToken:string;assistantTurnId:string;observation:SiteMarkdownObservationV3;
}
export interface CaptureEgressOptionsV3{
  storage:ChromeStorageAreaV1;runtime:BrowserAuthorityRuntimeV1;effects:RbridgeEffectStoreV1;
  extensionId:string;browserInstanceId:string;browserProfileId:string;ownerAppId:string;maxMessageBytes:number;
  initialHistory:readonly RbridgeChatEventV1[];publish:(event:RbridgeChatEventV1)=>Promise<void>;
  siteReader?:SiteMarkdownReaderV3;delivery?:ChatgptDeliveryAdapterV3;
  freshSendAdmission?:(request:CocwinRbridgeEffectRequestV1)=>void;
}
export interface CaptureMessageApiV3{
  onMessage:{addListener(listener:(message:unknown,sender:unknown,respond:(reply:unknown)=>void)=>boolean|void):void};
}
interface Owner{extensionId:string;browserInstanceId:string;browserProfileId:string;ownerAppId:string;maxMessageBytes:number}
interface RecordV3{notificationDigest:string;requestDigest:string;captureToken:string;assistantTurnId:string;event:RbridgeChatEventV1;siteAcquired?:true}
interface Outbox{schema:'RBRIDGE_CAPTURE_OUTBOX_V3';owner:Owner;history:RbridgeChatEventV1[];records:RecordV3[];sha256:string}
interface Authority{queue:Promise<void>;poisoned:boolean;seen:Outbox|null;sitePending:Map<string,Promise<CaptureAckV3>>;siteQuarantined:boolean;siteMutationFence:symbol;pendingEgress:number}
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
  let value=authorities.get(storage);if(!value){value={queue:Promise.resolve(),poisoned:false,seen:null,sitePending:new Map(),siteQuarantined:false,siteMutationFence:Symbol(),pendingEgress:0};authorities.set(storage,value);}return value;
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
    if(message===null||typeof message!=='object')return false;
    const schema=(message as Record<string,unknown>).schema,isSite=schema==='RBRIDGE_CONTENT_SITE_CAPTURE_V3';
    if(!isSite&&schema!=='RBRIDGE_CONTENT_CAPTURE_V3')return false;
    let notification:ContentCaptureNotificationV3|undefined,lease:string|undefined,source:ChromeCaptureSenderV3;
    try{
      if(isSite){const row=object(snapshotEffectData(message));exact(row,['schema','captureToken']);if(row.schema!=='RBRIDGE_CONTENT_SITE_CAPTURE_V3')fail();lease=id(row.captureToken,192);}
      else notification=parseContentCaptureNotificationV3(message);
      const row=object(sender),tab=object(row.tab);
      source=parseSender({id:row.id,tabId:tab.id,frameId:row.frameId,url:row.url} as ChromeCaptureSenderV3);
    }catch{respond({errorCode:'RBRIDGE_CAPTURE_REJECTED'});return false;}
    if(!egress){respond({errorCode:'RBRIDGE_CAPTURE_V3_UNAVAILABLE'});return false;}
    void (isSite?egress.acquireSite(lease!,source):egress.accept(notification!,source)).then(ack=>{
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
  private readonly activities:SiteCaptureActivityStoreV1;
  private readonly freshSendAdmission:CaptureEgressOptionsV3['freshSendAdmission'];
  constructor(private readonly options:CaptureEgressOptionsV3){
    this.owner=snapshotEffectData({extensionId:options.extensionId,browserInstanceId:options.browserInstanceId,browserProfileId:options.browserProfileId,ownerAppId:options.ownerAppId,maxMessageBytes:options.maxMessageBytes});
    if(!/^[a-p]{32}$/.test(this.owner.extensionId)||!Number.isSafeInteger(this.owner.maxMessageBytes)||this.owner.maxMessageBytes<4096||this.owner.maxMessageBytes>65536)fail();
    id(this.owner.browserInstanceId,128);id(this.owner.browserProfileId,128);id(this.owner.ownerAppId,192);
    this.history=snapshotEffectData([...options.initialHistory]);this.shared=authority(options.storage);
    this.activities=new SiteCaptureActivityStoreV1(options.storage,this.owner);this.freshSendAdmission=options.freshSendAdmission;
  }
  async acquireSite(captureLeaseToken:string,sender:ChromeCaptureSenderV3):Promise<CaptureAckV3>{
    const token=id(captureLeaseToken,192),source=parseSender(sender);
    if(!this.options.siteReader||!this.options.delivery)fail();
    const context=await this.captureContext(source,true),{request,capture}=context;
    if(token!=='capture:'+capture.sessionId+':'+String(capture.epoch))fail();
    const key=request.requestDigest+':'+String(capture.epoch),pending=this.shared.sitePending.get(key);
    if(pending)return snapshotEffectData(await pending);
    const work=this.acquireSiteOnce(context,source);this.shared.sitePending.set(key,work);
    try{return snapshotEffectData(await work);}finally{this.shared.sitePending.delete(key);}
  }
  private async acquireSiteOnce(context:Awaited<ReturnType<RbridgeCaptureEgressV3['captureContext']>>,source:ChromeCaptureSenderV3):Promise<CaptureAckV3>{
    const {state,request,capture}=context,token=captureTokenV3(request,capture.epoch);
    const cached=await this.exclusive(async()=>{
      const current=await this.load(),records=current?.records.filter(record=>record.requestDigest===request.requestDigest&&record.captureToken===token)??[];
      if(records.length>1)fail();if(records.length===1){if(records[0]!.siteAcquired!==true)fail();return this.ack(records[0]!.event);}
      this.assertSiteSlotEmpty(current,request,token);
      return null;
    });
    const admission=async()=>{
      const fence=await this.options.runtime.assertLiveSnapshot(state),slotFence=this.shared.siteMutationFence;
      await this.exclusive(async()=>this.assertSiteSlotEmpty(await this.load(),request,token));
      return ()=>{if(this.shared.siteMutationFence!==slotFence)fail();this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();};
    };
    if(cached)return await this.completeSiteCapture(context,cached);
    if(this.shared.siteQuarantined||state.activeSend?.state==='RESPONSE_VERIFIED')fail();
    const reader=this.options.siteReader!;
    if(typeof reader.startAcquire!=='function')throw Error('RBRIDGE_SITE_CAPTURE_SETTLEMENT_UNSUPPORTED');
    const lease=await this.activities.begin(request,capture.epoch,this.freshSendAdmission?()=>this.freshSendAdmission!(snapshotEffectData(request)):undefined);
    let work:SiteCaptureWorkV1;
    try{
      const delivery=await this.options.delivery!.observeExactDelivery(request);if(delivery.kind!=='MATCHED')fail();
      const readPermit=await admission();
      work=reader.startAcquire(request,delivery,async()=>{await lease.armCopy();return await admission();},readPermit);
      if(!work||typeof work.result?.then!=='function'||typeof work.settled?.then!=='function')throw Error('RBRIDGE_SITE_CAPTURE_SETTLEMENT_UNSUPPORTED');
    }catch(error){this.shared.siteQuarantined=true;await lease.quarantine('RBRIDGE_SITE_CAPTURE_START_UNSETTLED');throw error;}
    const raw={value:null as SiteCaptureRawOutcomeV1|null};
    const settlement=work.settled.then(async outcome=>{raw.value=outcome;await lease.settle(outcome);});
    void settlement.catch(()=>{this.shared.siteQuarantined=true;});
    let acquired:SiteMarkdownReadResultV3;
    try{
      acquired=await work.result;await settlement;
      if(raw.value?.outcome!=='COMPLETED'||raw.value.copyIssued!==true)throw Error('RBRIDGE_SITE_CAPTURE_SETTLEMENT_UNSUPPORTED');
    }catch(error){
      await Promise.resolve();
      if(error instanceof Error&&error.message==='RBRIDGE_SITE_CAPTURE_TIMEOUT'||raw.value===null){
        this.shared.siteQuarantined=true;await lease.quarantine(error instanceof Error&&error.message==='RBRIDGE_SITE_CAPTURE_TIMEOUT'?'RBRIDGE_SITE_CAPTURE_TIMEOUT':'RBRIDGE_SITE_CAPTURE_RESULT_UNSETTLED');
      }else await settlement;
      throw error;
    }
    (await admission())();
    const ack=await this.persistCapture({schema:'RBRIDGE_CONTENT_CAPTURE_V3',captureToken:token,assistantTurnId:acquired.assistantTurnId,observation:acquired.observation},source,true);
    return await this.completeSiteCapture(context,ack);
  }
  private assertSiteSlotEmpty(current:Outbox|null,request:CocwinRbridgeEffectRequestV1,token:string):void{
    if(current?.records.some(record=>record.requestDigest===request.requestDigest&&record.captureToken===token))fail();
    if((current?.history??this.history).some(event=>['CAPTURE_LOST','RESPONSE_CAPTURED','ASSISTANT_TURN_CAPTURED_V2','ASSISTANT_TURN_REJECTED_V2'].includes(event.eventType)&&event.effectId===request.effectId&&event.sessionId===request.sessionId&&event.generation===request.generation&&event.attemptId===request.attemptId))fail();
  }
  private async completeSiteCapture(context:Awaited<ReturnType<RbridgeCaptureEgressV3['captureContext']>>,ack:CaptureAckV3):Promise<CaptureAckV3>{
    return await this.exclusive(async()=>{
      const current=await this.load(),records=current?.records.filter(row=>row.requestDigest===context.request.requestDigest&&row.captureToken===captureTokenV3(context.request,context.capture.epoch))??[],record=records[0];
      if(records.length!==1||record?.event.eventId!==ack.eventId||record.event.eventSha256!==ack.eventSha256)fail();
      if(!record||record.siteAcquired!==true||record.requestDigest!==context.request.requestDigest||record.captureToken!==captureTokenV3(context.request,context.capture.epoch))fail();
      if(record.event.eventType==='ASSISTANT_TURN_CAPTURED_V2'&&context.state.activeSend?.state!=='RESPONSE_VERIFIED'){
        this.options.effects.assertMutationAvailable();
        await this.options.runtime.markCapturedResponseVerified(context.state,record.event);
      }else{
        const fence=await this.options.runtime.assertLiveSnapshot(context.state);this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();
      }
      return this.ack(record.event);
    });
  }
  private async captureContext(source:ChromeCaptureSenderV3,allowCompleted=false){
    const state=await this.options.runtime.state(),binding=state?.binding,tx=state?.activeSend,capture=state?.capture,leader=state?.leader;
    if(!state||binding?.status!=='VERIFIED'||capture?.status!=='ACTIVE'||leader?.status!=='ACTIVE'||!tx||!['SENT_VERIFIED','WAITING_RESPONSE',...(allowCompleted?['RESPONSE_VERIFIED']:[])].includes(tx.state))fail();
    if(source.id!==this.owner.extensionId||source.tabId!==binding.tabId||binding.browserInstanceId!==this.owner.browserInstanceId||binding.browserProfileId!==this.owner.browserProfileId)fail();
    const url=new URL(source.url);if(url.origin!==binding.origin||url.pathname!=='/g/'+binding.projectId+'/c/'+binding.conversationId||url.search||url.hash||url.username||url.password)fail();
    const request=await this.options.effects.requestForEffect(tx.effectId);
    if(!request||request.appId!==this.owner.ownerAppId||(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND'))fail();
    const payload=request.payload,target=payload.target;
    if(request.sessionId!==tx.sessionId||request.generation!==tx.generation||request.attemptId!==tx.attemptId||request.effectId!==tx.effectId||payload.challenge!==tx.challenge||payload.purpose!==tx.purpose)fail();
    for(const key of ['browserInstanceId','browserProfileId','windowId','tabId','origin','projectId','conversationId','conversationGeneration']as const)if(target[key]!==binding[key])fail();
    if(tx.conversationId!==binding.conversationId||tx.conversationGeneration!==binding.conversationGeneration||tx.captureEpoch!==capture.epoch||tx.writeLeaderEpoch!==leader.epoch||binding.sessionId!==request.sessionId||binding.generation!==request.generation||capture.sessionId!==request.sessionId||capture.generation!==request.generation)fail();
    return {state,request,binding,capture};
  }
  async accept(input:unknown,sender:ChromeCaptureSenderV3):Promise<CaptureAckV3>{return await this.persistCapture(input,sender,false);}
  private async persistCapture(input:unknown,sender:ChromeCaptureSenderV3,siteAcquired:boolean):Promise<CaptureAckV3>{
    // Both snapshots precede the first await and queue reservation.
    const notification=parseContentCaptureNotificationV3(input),source=parseSender(sender);
    // Invalidate a prepared Copy permit synchronously, before queue admission.
    this.shared.siteMutationFence=Symbol();
    return await this.exclusive(async()=>{
      const {state,request,binding,capture}=await this.captureContext(source),payload=request.payload;
      if(notification.captureToken!==captureTokenV3(request,capture.epoch))fail();
      const current=await this.load();if(siteAcquired)this.assertSiteSlotEmpty(current,request,notification.captureToken);
      const notificationDigest=await canonicalDigest(notification);
      const identity=await canonicalDigest({requestDigest:request.requestDigest,captureToken:notification.captureToken,assistantTurnId:notification.assistantTurnId});
      const prior=current?.records.find(record=>record.captureToken===notification.captureToken&&record.assistantTurnId===notification.assistantTurnId);
      if(prior){if(prior.notificationDigest!==notificationDigest||prior.requestDigest!==request.requestDigest)fail();const fence=await this.options.runtime.assertLiveSnapshot(state);this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();return this.ack(prior.event);}
      const historical=(current?.history??this.history).find(event=>event.eventId==='capture-event:'+identity);
      if(historical){
        for(const key of ['sessionId','generation','attemptId','effectId'] as const)if(historical[key]!==request[key])fail();
        if(notification.observation.kind==='UNAVAILABLE'){
          if(historical.eventType!=='CAPTURE_LOST'||historical.payload.reason!=='UI_PROTOCOL_CHANGED')fail();
        }else{
          if(!['ASSISTANT_TURN_CAPTURED_V2','ASSISTANT_TURN_REJECTED_V2'].includes(historical.eventType))fail();
          const receipt=object(historical.payload.captureReceipt),markdown=notification.observation.markdown;
          if(receipt.receiptId!=='capture-receipt:'+identity||receipt.assistantTurnId!==notification.assistantTurnId||receipt.challenge!==payload.challenge||receipt.conversationId!==binding.conversationId||receipt.conversationGeneration!==binding.conversationGeneration||receipt.captureEpoch!==capture.epoch||receipt.responseUtf8Bytes!==encoder.encode(markdown).byteLength||receipt.assistantTurnSha256!==await sha256Hex(markdown))fail();
          if(historical.eventType==='ASSISTANT_TURN_CAPTURED_V2'&&historical.payload.assistantTurnUtf8!==markdown)fail();
        }
        if(!current){
          // Register the trusted complete historical prefix durably before acknowledging its retry.
          const body={schema:'RBRIDGE_CAPTURE_OUTBOX_V3' as const,owner:this.owner,history:this.history,records:[]};
          await this.write({...body,sha256:await canonicalDigest(body)},state);
        }else{const fence=await this.options.runtime.assertLiveSnapshot(state);this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();}
        return this.ack(historical);
      }
      const all=[...(current?.history??this.history),...(current?.records.map(record=>record.event)??[])];
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
      const records=[...(current?.records??[]),{notificationDigest,requestDigest:request.requestDigest,captureToken:notification.captureToken,assistantTurnId:notification.assistantTurnId,event:nextEvent,...(siteAcquired?{siteAcquired:true as const}:{})}];
      const body={schema:'RBRIDGE_CAPTURE_OUTBOX_V3' as const,owner:this.owner,history:current?.history??this.history,records},next={...body,sha256:await canonicalDigest(body)};
      await this.write(next,state);
      return this.ack(nextEvent);
    }).catch(()=>fail());
  }
  async siteActivityFacts(scope:V3Scope):Promise<SiteCaptureActivityFactsV1>{return await this.activities.facts(scope);}
  async events():Promise<readonly RbridgeChatEventV1[]>{return await this.exclusive(async()=>snapshotEffectData((await this.load())?.records.map(record=>record.event)??[]));}
  get pendingEgress():number{return this.shared.pendingEgress;}
  async retainedEvents():Promise<readonly RbridgeChatEventV1[]>{return await this.exclusive(async()=>{const current=await this.load();return snapshotEffectData([...(current?.history??this.history),...(current?.records.map(record=>record.event)??[])]);});}
  async flush():Promise<void>{
    this.shared.pendingEgress++;try{
    // Disconnects preserve every original event and its chain; posting is never a durable Native ack.
    const events=await this.events();
    for(const event of events){if(bytes(event)>this.owner.maxMessageBytes)break;try{await this.options.publish(snapshotEffectData(event));}catch{break;}}
    }finally{this.shared.pendingEgress--;}
  }
  private ack(event:RbridgeChatEventV1):CaptureAckV3{return {eventId:event.eventId,eventSha256:event.eventSha256,durable:true};}
  private async write(next:Outbox,state:BrowserAuthoritySnapshotV1):Promise<void>{
    await this.validate(next);
    const fence=await this.options.runtime.assertLiveSnapshot(state);
    this.options.runtime.assertAdmission(fence);this.options.effects.assertMutationAvailable();
    try{
      await this.options.storage.set({[KEY]:snapshotEffectData(next)});
      const readback=await this.options.storage.get(KEY);if(!same(readback[KEY],next))fail();
      await this.validate(readback[KEY]);this.shared.seen=snapshotEffectData(next);
    }catch{this.shared.poisoned=true;fail();}
  }
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
    if(events.length>MAX_EVENTS||bytes(events)>LIMIT)fail();let previous:string|null=null;const ids=new Set<string>();
    for(let i=0;i<events.length;i++){const event=await validateEventEnvelope(events[i]);if(event.sequence!==i+1||event.previousEventSha256!==previous||ids.has(event.eventId))fail();ids.add(event.eventId);previous=event.eventSha256;}
  }
  private async validate(value:unknown):Promise<Outbox>{
    const row=object(snapshotEffectData(value));exact(row,['schema','owner','history','records','sha256']);
    if(row.schema!=='RBRIDGE_CAPTURE_OUTBOX_V3'||!same(row.owner,this.owner)||!same(row.history,this.history)||!Array.isArray(row.history)||!Array.isArray(row.records)||typeof row.sha256!=='string'||!SHA.test(row.sha256)||row.history.length+row.records.length>MAX_EVENTS||bytes(row)>LIMIT)fail();
    const history=row.history as RbridgeChatEventV1[];await this.validateHistory(history);let previous=history.at(-1)?.eventSha256??null;
    const ids=new Set<string>(history.map(event=>event.eventId)),keys=new Set<string>();
    for(let i=0;i<row.records.length;i++){
      const record=object(row.records[i]);exact(record,['notificationDigest','requestDigest','captureToken','assistantTurnId','event',...(Object.hasOwn(record,'siteAcquired')?['siteAcquired']:[])]);if(Object.hasOwn(record,'siteAcquired')&&record.siteAcquired!==true)fail();
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
