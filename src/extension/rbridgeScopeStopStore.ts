import {canonicalDigest,canonicalJson,parseV3Scope,type V3Scope} from '../domain/rbridgeEffectProtocol.js';
import type {ChromeStorageAreaV1} from './browserAuthorityStore.js';
import {snapshotEffectData} from './rbridgeEffectStore.js';

export interface RbridgeScopeStopRequestV1{
  schema:'RBRIDGE_SCOPE_STOP_REQUEST_V1';requestId:string;scope:V3Scope;challenge:string;issuedAt:string;requestDigest:string;
}
export interface RbridgeScopeStopFenceV1{
  schema:'RBRIDGE_SCOPE_STOP_FENCE_V1';state:'STOP_REQUESTED';request:RbridgeScopeStopRequestV1;recordedAt:string;sha256:string;
}
interface Authority{writes:Promise<void>;stopping:boolean;poisoned:boolean;seen:RbridgeScopeStopFenceV1|null}
const authorities=new WeakMap<ChromeStorageAreaV1,Authority>();
const KEY='rbridgeScopeStopV1',SHA=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function fail(code:string):never{throw Error(code);}
function object(input:unknown):Record<string,unknown>{if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_SCOPE_STOP_INVALID');return input as Record<string,unknown>;}
function exact(row:Record<string,unknown>,keys:string[]):void{if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))fail('RBRIDGE_SCOPE_STOP_INVALID');}
function iso(input:unknown):string{if(typeof input!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input)||!Number.isFinite(Date.parse(input))||new Date(input).toISOString()!==input)fail('RBRIDGE_SCOPE_STOP_INVALID');return input;}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
function requestShape(input:unknown,scope:V3Scope):RbridgeScopeStopRequestV1{
  const row=object(snapshotEffectData(input));exact(row,['schema','requestId','scope','challenge','issuedAt','requestDigest']);
  if(row.schema!=='RBRIDGE_SCOPE_STOP_REQUEST_V1'||typeof row.requestId!=='string'||!ID.test(row.requestId)||typeof row.challenge!=='string'||!SHA.test(row.challenge)||typeof row.requestDigest!=='string'||!SHA.test(row.requestDigest))fail('RBRIDGE_SCOPE_STOP_INVALID');
  const actual=parseV3Scope(row.scope);if(!same(actual,scope))fail('RBRIDGE_SCOPE_STOP_SCOPE_MISMATCH');
  iso(row.issuedAt);return row as unknown as RbridgeScopeStopRequestV1;
}
async function validateRequest(input:unknown,scope:V3Scope):Promise<RbridgeScopeStopRequestV1>{
  const request=requestShape(input,scope),{requestDigest,...body}=request;
  if(await canonicalDigest(body)!==requestDigest)fail('RBRIDGE_SCOPE_STOP_DIGEST_INVALID');return request;
}
async function validateFence(input:unknown,scope:V3Scope):Promise<RbridgeScopeStopFenceV1>{
  const row=object(snapshotEffectData(input));exact(row,['schema','state','request','recordedAt','sha256']);
  if(row.schema!=='RBRIDGE_SCOPE_STOP_FENCE_V1'||row.state!=='STOP_REQUESTED'||typeof row.sha256!=='string'||!SHA.test(row.sha256))fail('RBRIDGE_SCOPE_STOP_INVALID');
  await validateRequest(row.request,scope);iso(row.recordedAt);const {sha256,...body}=row;
  if(await canonicalDigest(body)!==sha256)fail('RBRIDGE_SCOPE_STOP_DIGEST_INVALID');return row as unknown as RbridgeScopeStopFenceV1;
}

// This record proves terminal admission fencing only. It does not prove that
// earlier browser work settled or that Native durably accepted retained egress.
export class RbridgeScopeStopStoreV1{
  private readonly scope:V3Scope;
  private readonly shared:Authority;
  private initialized=false;
  constructor(private readonly storage:ChromeStorageAreaV1,input:V3Scope){
    this.scope=parseV3Scope(snapshotEffectData(input));let shared=authorities.get(storage);
    if(!shared){shared={writes:Promise.resolve(),stopping:false,poisoned:false,seen:null};authorities.set(storage,shared);}this.shared=shared;
  }
  get stopped():boolean{return this.shared.stopping||this.shared.poisoned||this.shared.seen!==null;}
  async initialize():Promise<void>{await this.exclusive(async()=>{await this.load();});this.initialized=true;}
  assertExecuteAllowed():void{
    if(!this.initialized)fail('RBRIDGE_SCOPE_STOP_NOT_INITIALIZED');
    if(this.shared.stopping||this.shared.seen)fail('RBRIDGE_SCOPE_STOP_REQUESTED');
    if(this.shared.poisoned)fail('RBRIDGE_SCOPE_STOP_STORAGE_UNAVAILABLE');
  }
  async requestStop(input:unknown):Promise<RbridgeScopeStopFenceV1>{
    if(!this.initialized)fail('RBRIDGE_SCOPE_STOP_NOT_INITIALIZED');
    // Reject a structurally invalid or foreign scope before changing admission.
    const snapshot=requestShape(input,this.scope);
    // Reserve STOP synchronously, before digest/storage awaits. Failure never
    // reopens this worker; only successful readback is returned as durable.
    this.shared.stopping=true;
    return await this.exclusive(async()=>{
      const request=await validateRequest(snapshot,this.scope),current=await this.load();
      if(current){if(!same(current.request,request))fail(current.request.requestId===request.requestId?'REQUEST_ID_COLLISION':'RBRIDGE_SCOPE_STOP_ALREADY_REQUESTED');return snapshotEffectData(current);}
      const body={schema:'RBRIDGE_SCOPE_STOP_FENCE_V1' as const,state:'STOP_REQUESTED' as const,request,recordedAt:new Date().toISOString()},next={...body,sha256:await canonicalDigest(body)};
      await validateFence(next,this.scope);
      try{
        await this.storage.set({[KEY]:snapshotEffectData(next)});
        const readback=(await this.storage.get(KEY))[KEY];if(!same(readback,next))fail('RBRIDGE_SCOPE_STOP_WRITE_UNCERTAIN');
        const validated=await validateFence(readback,this.scope);this.shared.seen=snapshotEffectData(validated);return snapshotEffectData(validated);
      }catch{this.shared.poisoned=true;fail('RBRIDGE_SCOPE_STOP_WRITE_UNCERTAIN');}
    });
  }
  private exclusive<T>(run:()=>Promise<T>):Promise<T>{
    const result=this.shared.writes.then(run);this.shared.writes=result.then(()=>undefined,()=>undefined);return result;
  }
  private async load():Promise<RbridgeScopeStopFenceV1|null>{
    if(this.shared.poisoned)fail('RBRIDGE_SCOPE_STOP_STORAGE_UNAVAILABLE');
    try{
      const value=(await this.storage.get(KEY))[KEY];
      if(value===undefined){if(this.shared.seen)fail('RBRIDGE_SCOPE_STOP_MISSING');return null;}
      const next=await validateFence(value,this.scope);if(this.shared.seen&&!same(this.shared.seen,next))fail('RBRIDGE_SCOPE_STOP_CHANGED');
      this.shared.seen=snapshotEffectData(next);this.shared.stopping=true;return next;
    }catch{this.shared.poisoned=true;fail('RBRIDGE_SCOPE_STOP_STORAGE_UNAVAILABLE');}
  }
}
