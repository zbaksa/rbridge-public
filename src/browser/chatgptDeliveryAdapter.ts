import {canonicalDigest,canonicalJson,parseEffectRequest,sha256Hex,type CocwinRbridgeEffectRequestV1} from '../domain/rbridgeEffectProtocol.js';
import {requireExactProjectConversationUrl} from './chatgptConversationIdentity.js';
import {snapshotEffectData} from '../extension/rbridgeEffectStore.js';
import type {ChromeStorageAreaV1} from '../extension/browserAuthorityStore.js';

export type DeliveryObservationV3=
  |{kind:'MATCHED';userTurnId:string;textSha256:string;conversationId:string;observedAt:string}
  |{kind:'UNAVAILABLE';reason:string};
export interface DeliverySurfaceV3{
  documentId:string;documentUrl:string;observedAt:string;turns:{userTurnId:string;textSha256:string}[];
}
export interface ChatgptDeliverySurfaceReaderV3{scan(target:CocwinRbridgeEffectRequestV1['payload']['target']):Promise<DeliverySurfaceV3|null>}
export interface DeliveryClickGuardV3{documentId:string;documentUrl:string;baselineUserTurnIds:string[];text:string}
interface RecordV3{schema:'RBRIDGE_DELIVERY_BASELINE_V3';request:CocwinRbridgeEffectRequestV1;baseline:DeliverySurfaceV3;observation:Extract<DeliveryObservationV3,{kind:'MATCHED'}>|null;sha256:string}
interface Authority{tail:Promise<void>;poisoned:boolean;seen:Map<string,RecordV3>}
const owners=new WeakMap<ChromeStorageAreaV1,Authority>();
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,SHA=/^[0-9a-f]{64}$/;
function fail(code:string):never{throw Error(code);}
function iso(value:unknown):value is string{return typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;}
function exact(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');return row;
}
function surface(input:unknown,request:CocwinRbridgeEffectRequestV1):DeliverySurfaceV3{
  const row=exact(snapshotEffectData(input),['documentId','documentUrl','observedAt','turns']),t=request.payload.target;
  if(typeof row.documentId!=='string'||!ID.test(row.documentId)||typeof row.documentUrl!=='string'||!iso(row.observedAt)||!Array.isArray(row.turns)||row.turns.length>500)fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
  const parsed=requireExactProjectConversationUrl(row.documentUrl);
  if(parsed.origin!==t.origin||parsed.projectId!==t.projectId||parsed.canonicalProjectId!==t.canonicalProjectId||parsed.conversationId!==t.conversationId)fail('BROWSER_BINDING_STALE');
  const seen=new Set<string>();
  for(const turn of row.turns){const r=exact(turn,['userTurnId','textSha256']);if(typeof r.userTurnId!=='string'||!ID.test(r.userTurnId)||seen.has(r.userTurnId)||typeof r.textSha256!=='string'||!SHA.test(r.textSha256))fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');seen.add(r.userTurnId);}
  if(new TextEncoder().encode(canonicalJson(row)).byteLength>65536)fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
  return row as unknown as DeliverySurfaceV3;
}

// One owning worker; adapter instances sharing the same storage object share the
// write queue and poison fence. Durable readback is required before any click.
export class ChatgptDeliveryAdapterV3{
  private readonly owner:Authority;
  constructor(private readonly storage:ChromeStorageAreaV1,private readonly reader:ChatgptDeliverySurfaceReaderV3){
    let owner=owners.get(storage);if(!owner){owner={tail:Promise.resolve(),poisoned:false,seen:new Map()};owners.set(storage,owner);}this.owner=owner;
  }
  assertAvailable():void{if(this.owner.poisoned)fail('RBRIDGE_DELIVERY_STORAGE_UNAVAILABLE');}
  async prepareDelivery(input:CocwinRbridgeEffectRequestV1):Promise<DeliveryClickGuardV3>{
    const snapshot=snapshotEffectData(input);
    return await this.exclusive(async()=>{
      const request=await parseEffectRequest(snapshot,65536);if(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND')fail('RBRIDGE_DELIVERY_SEND_REQUIRED');
      let record=await this.load(request);
      if(!record){const baseline=surface(await this.reader.scan(request.payload.target),request);record=await this.write({schema:'RBRIDGE_DELIVERY_BASELINE_V3',request,baseline,observation:null});}
      if(record.observation)fail('RBRIDGE_SEND_RECONCILE_REQUIRED');
      return {documentId:record.baseline.documentId,documentUrl:record.baseline.documentUrl,baselineUserTurnIds:record.baseline.turns.map(turn=>turn.userTurnId),text:request.payload.text};
    });
  }
  async observeExactDelivery(input:CocwinRbridgeEffectRequestV1):Promise<DeliveryObservationV3>{
    const snapshot=snapshotEffectData(input);
    try{return await this.exclusive(async()=>{
      const request=await parseEffectRequest(snapshot,65536);if(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND')fail('RBRIDGE_DELIVERY_SEND_REQUIRED');
      const record=await this.load(request);if(!record)fail('RBRIDGE_DELIVERY_BASELINE_MISSING');
      const current=surface(await this.reader.scan(request.payload.target),request);
      if(current.documentId!==record.baseline.documentId||Date.parse(current.observedAt)<Date.parse(record.baseline.observedAt))fail('RBRIDGE_DELIVERY_DOCUMENT_CHANGED');
      const old=new Set(record.baseline.turns.map(turn=>turn.userTurnId)),ids=new Set(current.turns.map(turn=>turn.userTurnId));
      if([...old].some(id=>!ids.has(id)))fail('RBRIDGE_DELIVERY_BASELINE_LOST');
      const added=current.turns.filter(turn=>!old.has(turn.userTurnId));
      if(added.length!==1||added[0]!.textSha256!==await sha256Hex(request.payload.text))fail('RBRIDGE_DELIVERY_NOT_EXACT');
      const observation:Extract<DeliveryObservationV3,{kind:'MATCHED'}>={kind:'MATCHED',userTurnId:added[0]!.userTurnId,textSha256:added[0]!.textSha256,conversationId:request.payload.target.conversationId,observedAt:current.observedAt};
      if(record.observation){if(record.observation.userTurnId!==observation.userTurnId||record.observation.textSha256!==observation.textSha256)fail('RBRIDGE_DELIVERY_OBSERVATION_COLLISION');return snapshotEffectData(record.observation);}
      await this.write({schema:record.schema,request:record.request,baseline:record.baseline,observation});return snapshotEffectData(observation);
    });}catch{return {kind:'UNAVAILABLE',reason:'RBRIDGE_DELIVERY_UNAVAILABLE'};}
  }
  private async exclusive<T>(run:()=>Promise<T>):Promise<T>{const result=this.owner.tail.then(()=>{this.assertAvailable();return run();});this.owner.tail=result.then(()=>undefined,()=>undefined);return await result;}
  private async load(request:CocwinRbridgeEffectRequestV1):Promise<RecordV3|null>{
    this.assertAvailable();const key='rbridgeDeliveryV3:'+request.effectId,prior=this.owner.seen.get(key);
    try{
      const raw=(await this.storage.get(key))[key];if(raw===undefined){if(prior)fail('RBRIDGE_DELIVERY_BASELINE_LOST');return null;}
      const row=exact(snapshotEffectData(raw),['schema','request','baseline','observation','sha256']);
      if(row.schema!=='RBRIDGE_DELIVERY_BASELINE_V3'||typeof row.sha256!=='string'||!SHA.test(row.sha256))fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
      const parsed=await parseEffectRequest(row.request,65536);if(canonicalJson(parsed)!==canonicalJson(request))fail('REQUEST_ID_COLLISION');
      const baseline=surface(row.baseline,parsed);let observation:RecordV3['observation']=null;
      if(row.observation!==null){const o=exact(row.observation,['kind','userTurnId','textSha256','conversationId','observedAt']);
        if(o.kind!=='MATCHED'||typeof o.userTurnId!=='string'||!ID.test(o.userTurnId)||typeof o.textSha256!=='string'||!SHA.test(o.textSha256)||o.conversationId!==parsed.payload.target.conversationId||!iso(o.observedAt)||baseline.turns.some(turn=>turn.userTurnId===o.userTurnId)||Date.parse(o.observedAt)<Date.parse(baseline.observedAt))fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
        if(parsed.effectKind!=='RBRIDGE_SEND'&&parsed.effectKind!=='RBRIDGE_RESULT_SEND')fail('RBRIDGE_DELIVERY_SEND_REQUIRED');
        if(o.textSha256!==await sha256Hex(parsed.payload.text))fail('RBRIDGE_DELIVERY_NOT_EXACT');observation=o as unknown as RecordV3['observation'];}
      const body={schema:'RBRIDGE_DELIVERY_BASELINE_V3' as const,request:parsed,baseline,observation};if(await canonicalDigest(body)!==row.sha256)fail('RBRIDGE_DELIVERY_EVIDENCE_INVALID');
      const record={...body,sha256:row.sha256};if(prior&&(canonicalJson(prior.baseline)!==canonicalJson(record.baseline)||(prior.observation&&canonicalJson(prior.observation)!==canonicalJson(record.observation))))fail('RBRIDGE_DELIVERY_BASELINE_LOST');
      this.owner.seen.set(key,snapshotEffectData(record));return record;
    }catch(error){this.owner.poisoned=true;throw error;}
  }
  private async write(body:Omit<RecordV3,'sha256'>):Promise<RecordV3>{
    const record={...snapshotEffectData(body),sha256:await canonicalDigest(body)},key='rbridgeDeliveryV3:'+record.request.effectId;
    try{this.assertAvailable();await this.storage.set({[key]:snapshotEffectData(record)});const readback=await this.load(record.request);if(canonicalJson(readback)!==canonicalJson(record))fail('RBRIDGE_DELIVERY_READBACK_UNCERTAIN');return snapshotEffectData(record);}
    catch(error){this.owner.poisoned=true;throw error;}
  }
}
