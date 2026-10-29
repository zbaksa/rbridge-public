import {canonicalDigest,canonicalJson,parseEffectRequest,parseV3Scope,type CocwinRbridgeEffectRequestV1,type ExactBrowserTargetV1,type V3Scope} from '../domain/rbridgeEffectProtocol.js';
import type {ChromeStorageAreaV1} from './browserAuthorityStore.js';
import {snapshotEffectData} from './rbridgeEffectStore.js';

export interface SiteCaptureActivityOwnerV1{extensionId:string;browserInstanceId:string;browserProfileId:string;ownerAppId:string;maxMessageBytes:number}
export interface SiteCaptureRawOutcomeV1{outcome:'COMPLETED'|'FAILED';copyIssued:boolean}
interface Identity{requestDigest:string;effectId:string;attemptId:string;captureEpoch:number;target:ExactBrowserTargetV1}
interface RawTask{ordinal:number;startedAt:string;copyArmedAt:string|null;settledAt:string|null;outcome:'COMPLETED'|'FAILED'|null;copyIssued:boolean|null;quarantinedAt:string|null;quarantineReason:string|null}
interface Attempt{identity:Identity;tasks:RawTask[]}
interface Ledger{schema:'RBRIDGE_SITE_CAPTURE_ACTIVITY_V1';owner:SiteCaptureActivityOwnerV1;scope:V3Scope;revision:number;attempts:Attempt[];sha256:string}
interface Authority{queue:Promise<void>;poisoned:boolean;seen:Ledger|null}
export interface SiteCaptureTaskLeaseV1{armCopy():Promise<void>;quarantine(reason:string):Promise<void>;settle(outcome:SiteCaptureRawOutcomeV1):Promise<void>}
export interface SiteCaptureActivityFactsV1{
  schema:'RBRIDGE_SITE_CAPTURE_ACTIVITY_FACTS_V1';scope:V3Scope;history:'ABSENT'|'PRESENT';revision:number;retainedSha256:string|null;
  pendingCount:number;quarantinedCount:number;copyIssuedCount:number;
  identities:{requestDigest:string;effectId:string;captureEpoch:number;rawTaskCount:number;pendingCount:number;quarantinedCount:number;copyIssuedCount:number}[];
}
const KEY='rbridgeSiteCaptureActivityV1',SHA=/^[a-f0-9]{64}$/,REASON=/^[A-Z][A-Z0-9_:-]{0,127}$/,LIMIT=8*1024*1024,MAX_IDENTITIES=128,MAX_RAW=4096;
const authorities=new WeakMap<ChromeStorageAreaV1,Authority>();
function fail(code:string):never{throw Error(code);}
function object(input:unknown):Record<string,unknown>{if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_SITE_ACTIVITY_INVALID');return input as Record<string,unknown>;}
function exact(row:Record<string,unknown>,keys:string[]):void{if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))fail('RBRIDGE_SITE_ACTIVITY_INVALID');}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
function integer(input:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number{if(typeof input!=='number'||!Number.isSafeInteger(input)||input<min||input>max)fail('RBRIDGE_SITE_ACTIVITY_INVALID');return input;}
function text(input:unknown,max:number):string{if(typeof input!=='string'||!input||input.length>max||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input))fail('RBRIDGE_SITE_ACTIVITY_INVALID');return input;}
function iso(input:unknown):string{if(typeof input!=='string'||!Number.isFinite(Date.parse(input))||new Date(input).toISOString()!==input)fail('RBRIDGE_SITE_ACTIVITY_INVALID');return input;}
function scopeOf(request:CocwinRbridgeEffectRequestV1):V3Scope{return parseV3Scope({appId:request.appId,baseSha:request.baseSha,sessionId:request.sessionId,generation:request.generation});}
function identityOf(request:CocwinRbridgeEffectRequestV1,captureEpoch:number):Identity{return snapshotEffectData({requestDigest:request.requestDigest,effectId:request.effectId,attemptId:request.attemptId,captureEpoch,target:request.payload.target});}
function validateIdentity(input:unknown,scope:V3Scope):Identity{
  const row=object(input);exact(row,['requestDigest','effectId','attemptId','captureEpoch','target']);
  if(typeof row.requestDigest!=='string'||!SHA.test(row.requestDigest)||typeof row.effectId!=='string'||!SHA.test(row.effectId)||typeof row.attemptId!=='string'||!row.attemptId.startsWith(scope.sessionId+':a:')||!/^exta-[a-f0-9]{32}:a:[1-9][0-9]*$/.test(row.attemptId))fail('RBRIDGE_SITE_ACTIVITY_INVALID');
  integer(row.captureEpoch,1);const t=object(row.target);exact(t,['browserInstanceId','browserProfileId','windowId','tabId','origin','canonicalProjectId','projectId','conversationId','conversationGeneration']);
  text(t.browserInstanceId,128);text(t.browserProfileId,128);integer(t.windowId,0,2147483647);integer(t.tabId,0,2147483647);
  if(t.origin!=='https://chatgpt.com')fail('RBRIDGE_SITE_ACTIVITY_INVALID');text(t.canonicalProjectId,256);text(t.projectId,256);text(t.conversationId,256);integer(t.conversationGeneration,1,2147483647);
  return row as unknown as Identity;
}
function validateTask(input:unknown,index:number):RawTask{
  const row=object(input);exact(row,['ordinal','startedAt','copyArmedAt','settledAt','outcome','copyIssued','quarantinedAt','quarantineReason']);
  if(integer(row.ordinal,1)!==index+1)fail('RBRIDGE_SITE_ACTIVITY_INVALID');iso(row.startedAt);if(row.copyArmedAt!==null)iso(row.copyArmedAt);
  if(row.settledAt===null){if(row.outcome!==null||row.copyIssued!==null)fail('RBRIDGE_SITE_ACTIVITY_INVALID');}
  else{iso(row.settledAt);if(!['COMPLETED','FAILED'].includes(String(row.outcome))||typeof row.copyIssued!=='boolean'||row.copyIssued&&row.copyArmedAt===null)fail('RBRIDGE_SITE_ACTIVITY_INVALID');}
  if(row.quarantinedAt===null){if(row.quarantineReason!==null)fail('RBRIDGE_SITE_ACTIVITY_INVALID');}
  else{iso(row.quarantinedAt);if(typeof row.quarantineReason!=='string'||!REASON.test(row.quarantineReason))fail('RBRIDGE_SITE_ACTIVITY_INVALID');}
  return row as unknown as RawTask;
}
function extendsLedger(prior:Ledger,next:Ledger):void{
  if(next.revision<prior.revision||next.revision===prior.revision&&!same(prior,next)||next.attempts.length<prior.attempts.length)fail('RBRIDGE_SITE_ACTIVITY_ROLLBACK');
  for(let i=0;i<prior.attempts.length;i++){
    const old=prior.attempts[i]!,fresh=next.attempts[i]!;if(!same(old.identity,fresh.identity)||fresh.tasks.length<old.tasks.length)fail('RBRIDGE_SITE_ACTIVITY_ROLLBACK');
    for(let j=0;j<old.tasks.length;j++){
      const a=old.tasks[j]!,b=fresh.tasks[j]!,allowed={...a};
      if(a.settledAt===null){allowed.copyArmedAt=b.copyArmedAt;allowed.settledAt=b.settledAt;allowed.outcome=b.outcome;allowed.copyIssued=b.copyIssued;}
      if(a.quarantinedAt===null){allowed.quarantinedAt=b.quarantinedAt;allowed.quarantineReason=b.quarantineReason;}
      if(!same(allowed,b)||a.copyArmedAt!==null&&a.copyArmedAt!==b.copyArmedAt)fail('RBRIDGE_SITE_ACTIVITY_ROLLBACK');
    }
  }
}
export class SiteCaptureActivityStoreV1{
  private readonly owner:SiteCaptureActivityOwnerV1;private readonly shared:Authority;
  constructor(private readonly storage:ChromeStorageAreaV1,owner:SiteCaptureActivityOwnerV1){
    this.owner=snapshotEffectData(owner);let shared=authorities.get(storage);if(!shared){shared={queue:Promise.resolve(),poisoned:false,seen:null};authorities.set(storage,shared);}this.shared=shared;
  }
  async begin(input:CocwinRbridgeEffectRequestV1,captureEpoch:number,freshAdmission?:()=>void):Promise<SiteCaptureTaskLeaseV1>{
    const snapshot=snapshotEffectData(input);integer(captureEpoch,1);
    const reservation=await this.exclusive(async()=>{
      const request=await parseEffectRequest(snapshot,65536),scope=scopeOf(request),identity=identityOf(request,captureEpoch);
      if(request.appId!==this.owner.ownerAppId||identity.target.browserInstanceId!==this.owner.browserInstanceId||identity.target.browserProfileId!==this.owner.browserProfileId||(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND'))fail('RBRIDGE_SITE_ACTIVITY_SCOPE_MISMATCH');
      const current=await this.load(scope),attempts=snapshotEffectData(current?.attempts??[]),existing=attempts.find(row=>row.identity.requestDigest===identity.requestDigest&&row.identity.captureEpoch===captureEpoch);
      let attempt:Attempt;
      if(existing){if(!same(existing.identity,identity))fail('REQUEST_ID_COLLISION');attempt=existing;}
      else{if(!freshAdmission)fail('RBRIDGE_SITE_CAPTURE_HISTORY_UNPROVEN');freshAdmission();if(attempts.length>=MAX_IDENTITIES)fail('RBRIDGE_SITE_ACTIVITY_FULL');attempt={identity,tasks:[]};attempts.push(attempt);}
      if(attempt.tasks.some(row=>row.quarantinedAt!==null))fail('RBRIDGE_SITE_CAPTURE_QUARANTINED');
      if(attempt.tasks.some(row=>row.settledAt===null))fail('RBRIDGE_SITE_CAPTURE_PENDING');
      if(attempt.tasks.some(row=>row.copyIssued===true))fail('RBRIDGE_SITE_CAPTURE_ALREADY_COPIED');
      if(attempts.reduce((n,row)=>n+row.tasks.length,0)>=MAX_RAW)fail('RBRIDGE_SITE_ACTIVITY_FULL');
      const task:RawTask={ordinal:attempt.tasks.length+1,startedAt:new Date().toISOString(),copyArmedAt:null,settledAt:null,outcome:null,copyIssued:null,quarantinedAt:null,quarantineReason:null};attempt.tasks.push(task);
      await this.write(scope,current,attempts);return {scope,identity,ordinal:task.ordinal};
    });
    const mutate=(run:(task:RawTask)=>void)=>this.exclusive(async()=>{
      const current=await this.load(reservation.scope);if(!current)fail('RBRIDGE_SITE_ACTIVITY_MISSING');
      const attempts=snapshotEffectData(current.attempts),attempt=attempts.find(row=>same(row.identity,reservation.identity)),task=attempt?.tasks[reservation.ordinal-1];if(!task)fail('RBRIDGE_SITE_ACTIVITY_MISSING');
      const before=canonicalJson(task);run(task);if(canonicalJson(task)!==before)await this.write(reservation.scope,current,attempts);
    });
    return {
      armCopy:()=>mutate(task=>{if(task.settledAt!==null||task.quarantinedAt!==null)fail('RBRIDGE_SITE_CAPTURE_QUARANTINED');task.copyArmedAt??=new Date().toISOString();}),
      quarantine:reason=>mutate(task=>{if(!REASON.test(reason))fail('RBRIDGE_SITE_ACTIVITY_INVALID');if(task.quarantinedAt===null){task.quarantinedAt=new Date().toISOString();task.quarantineReason=reason;}}),
      settle:outcome=>mutate(task=>{const value=snapshotEffectData(outcome);if(!['COMPLETED','FAILED'].includes(value.outcome)||typeof value.copyIssued!=='boolean')fail('RBRIDGE_SITE_ACTIVITY_INVALID');if(task.settledAt!==null){if(task.outcome!==value.outcome||task.copyIssued!==value.copyIssued)fail('REQUEST_ID_COLLISION');return;}if(value.copyIssued&&task.copyArmedAt===null)fail('RBRIDGE_SITE_ACTIVITY_INVALID');task.settledAt=new Date().toISOString();task.outcome=value.outcome;task.copyIssued=value.copyIssued;}),
    };
  }
  async facts(input:V3Scope):Promise<SiteCaptureActivityFactsV1>{
    const scope=parseV3Scope(snapshotEffectData(input));
    return await this.exclusive(async()=>{
      const current=await this.load(scope),identities=(current?.attempts??[]).map(row=>({requestDigest:row.identity.requestDigest,effectId:row.identity.effectId,captureEpoch:row.identity.captureEpoch,rawTaskCount:row.tasks.length,pendingCount:row.tasks.filter(task=>task.settledAt===null).length,quarantinedCount:row.tasks.filter(task=>task.quarantinedAt!==null).length,copyIssuedCount:row.tasks.filter(task=>task.copyIssued===true).length}));
      return {schema:'RBRIDGE_SITE_CAPTURE_ACTIVITY_FACTS_V1',scope,history:current?'PRESENT':'ABSENT',revision:current?.revision??0,retainedSha256:current?.sha256??null,pendingCount:identities.reduce((n,row)=>n+row.pendingCount,0),quarantinedCount:identities.reduce((n,row)=>n+row.quarantinedCount,0),copyIssuedCount:identities.reduce((n,row)=>n+row.copyIssuedCount,0),identities};
    });
  }
  private exclusive<T>(run:()=>Promise<T>):Promise<T>{const result=this.shared.queue.then(()=>{if(this.shared.poisoned)fail('RBRIDGE_SITE_ACTIVITY_STORAGE_UNAVAILABLE');return run();});this.shared.queue=result.then(()=>undefined,()=>undefined);return result;}
  private async validate(input:unknown,scope:V3Scope):Promise<Ledger>{
    const row=object(snapshotEffectData(input));exact(row,['schema','owner','scope','revision','attempts','sha256']);
    if(row.schema!=='RBRIDGE_SITE_CAPTURE_ACTIVITY_V1'||!same(row.owner,this.owner)||!same(parseV3Scope(row.scope),scope)||!Array.isArray(row.attempts)||row.attempts.length>MAX_IDENTITIES||typeof row.sha256!=='string'||!SHA.test(row.sha256)||new TextEncoder().encode(canonicalJson(row)).length>LIMIT)fail('RBRIDGE_SITE_ACTIVITY_INVALID');integer(row.revision,1);
    const keys=new Set<string>();let raw=0;
    for(const item of row.attempts){const attempt=object(item);exact(attempt,['identity','tasks']);const identity=validateIdentity(attempt.identity,scope),key=identity.requestDigest+':'+identity.captureEpoch;if(keys.has(key)||!Array.isArray(attempt.tasks)||attempt.tasks.length===0)fail('RBRIDGE_SITE_ACTIVITY_INVALID');keys.add(key);raw+=attempt.tasks.length;if(raw>MAX_RAW)fail('RBRIDGE_SITE_ACTIVITY_FULL');const tasks=attempt.tasks.map(validateTask);if(tasks.some((task,i)=>i<tasks.length-1&&(task.settledAt===null||task.copyIssued!==false||task.quarantinedAt!==null))||tasks.filter(task=>task.copyIssued===true).length>1)fail('RBRIDGE_SITE_ACTIVITY_INVALID');if(identity.target.browserInstanceId!==this.owner.browserInstanceId||identity.target.browserProfileId!==this.owner.browserProfileId)fail('RBRIDGE_SITE_ACTIVITY_SCOPE_MISMATCH');}
    const {sha256,...body}=row;if(await canonicalDigest(body)!==sha256)fail('RBRIDGE_SITE_ACTIVITY_INVALID');return row as unknown as Ledger;
  }
  private async load(scope:V3Scope):Promise<Ledger|null>{
    try{const value=(await this.storage.get(KEY))[KEY];if(value===undefined){if(this.shared.seen)fail('RBRIDGE_SITE_ACTIVITY_MISSING');return null;}const next=await this.validate(value,scope);if(this.shared.seen)extendsLedger(this.shared.seen,next);this.shared.seen=snapshotEffectData(next);return next;}
    catch{this.shared.poisoned=true;fail('RBRIDGE_SITE_ACTIVITY_STORAGE_UNAVAILABLE');}
  }
  private async write(scope:V3Scope,current:Ledger|null,attempts:Attempt[]):Promise<void>{
    const body={schema:'RBRIDGE_SITE_CAPTURE_ACTIVITY_V1' as const,owner:this.owner,scope,revision:(current?.revision??0)+1,attempts},next={...body,sha256:await canonicalDigest(body)};await this.validate(next,scope);if(current)extendsLedger(current,next);
    try{await this.storage.set({[KEY]:snapshotEffectData(next)});const readback=(await this.storage.get(KEY))[KEY];if(!same(readback,next))fail('RBRIDGE_SITE_ACTIVITY_WRITE_UNCERTAIN');const validated=await this.validate(readback,scope);this.shared.seen=snapshotEffectData(validated);}
    catch{this.shared.poisoned=true;fail('RBRIDGE_SITE_ACTIVITY_STORAGE_UNAVAILABLE');}
  }
}
