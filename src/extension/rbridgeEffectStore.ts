import {
  canonicalDigest,canonicalJson,parseEffectCommand,parseEffectResult,
  type CocwinRbridgeEffectRequestV1,type EffectExecutionV3,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,
} from '../domain/rbridgeEffectProtocol.js';
import type {ChromeStorageAreaV1} from './browserAuthorityStore.js';

const KEY='rbridgeEffectLedgerV1';
const WIRE_BYTES=65536,LEDGER_BYTES=4*1024*1024;
const SHA=/^[0-9a-f]{64}$/;
interface CommandRecord{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1|null}
interface EffectRecord{effectId:string;requestDigest:string;executeCommandId:string;outcome:EffectExecutionV3;result:RbridgeChatEffectResultV1|null}
interface Ledger{schema:'RBRIDGE_EFFECT_LEDGER_V1';revision:number;commands:CommandRecord[];effects:EffectRecord[];sha256:string}
interface Authority{
  writes:Promise<void>;mutations:Promise<void>;poisoned:boolean;seen:Ledger|null;
  pending:Map<string,{fingerprint:string;result:Promise<RbridgeChatEffectResultV1>}>;
}
const authorities=new WeakMap<ChromeStorageAreaV1,Authority>();
function authority(storage:ChromeStorageAreaV1):Authority{
  let value=authorities.get(storage);if(!value){value={writes:Promise.resolve(),mutations:Promise.resolve(),poisoned:false,seen:null,pending:new Map()};authorities.set(storage,value);}return value;
}
function fail(code:string):never{throw Error(code);}
function object(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_EFFECT_LEDGER_INVALID');return value as Record<string,unknown>;}
function exact(row:Record<string,unknown>,keys:string[]):void{if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key)))fail('RBRIDGE_EFFECT_LEDGER_INVALID');}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}

// Snapshot plain JSON synchronously, before reserving a queue or awaiting crypto.
export function snapshotEffectData<T>(input:T):T{
  const visit=(value:unknown,depth:number):unknown=>{
    if(depth>16)fail('RBRIDGE_V3_SCHEMA_INVALID');
    if(value===null||typeof value==='string'||typeof value==='boolean')return value;
    if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('RBRIDGE_V3_SCHEMA_INVALID');return value;}
    if(typeof value!=='object')fail('RBRIDGE_V3_SCHEMA_INVALID');
    const proto=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(Array.isArray(value)){
      if(proto!==Array.prototype||keys.some(key=>typeof key!=='string'||(key!=='length'&&!/^(0|[1-9][0-9]*)$/.test(key)))||keys.length!==value.length+1)fail('RBRIDGE_V3_SCHEMA_INVALID');
      return Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value' in d)||!d.enumerable)fail('RBRIDGE_V3_SCHEMA_INVALID');return visit(d.value,depth+1);});
    }
    if(proto!==Object.prototype&&proto!==null)fail('RBRIDGE_V3_SCHEMA_INVALID');
    const out:Record<string,unknown>={};
    for(const key of keys){if(typeof key!=='string'||key==='__proto__'||key==='toJSON'||!/^[\x20-\x7e]+$/.test(key))fail('RBRIDGE_V3_SCHEMA_INVALID');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d)||!d.enumerable)fail('RBRIDGE_V3_SCHEMA_INVALID');out[key]=visit(d.value,depth+1);}
    return out;
  };
  return visit(input,0) as T;
}
export function pendingEffectOutcome(request:CocwinRbridgeEffectRequestV1):EffectExecutionV3{
  return {state:'UNCERTAIN',receipt:null,reason:request.effectKind==='RBRIDGE_SEND'||request.effectKind==='RBRIDGE_RESULT_SEND'?'SEND_UNCERTAIN':'EXTERNAL_AGENT_EFFECT_OUTCOME_UNCERTAIN'};
}
export async function buildEffectResult(command:RbridgeChatEffectCommandV1,input:EffectExecutionV3):Promise<RbridgeChatEffectResultV1>{
  const observation=snapshotEffectData(input),request=command.request;
  const body={schema:'RBRIDGE_CHAT_EFFECT_RESULT_V1' as const,commandId:command.commandId,commandSha256:command.commandSha256,sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,requestDigest:request.requestDigest,completedAt:new Date().toISOString(),state:observation.state,receipt:observation.receipt,reason:observation.reason};
  return await parseEffectResult({...body,resultSha256:await canonicalDigest(body)},command,WIRE_BYTES);
}
function observation(result:RbridgeChatEffectResultV1):EffectExecutionV3{return {state:result.state,receipt:result.receipt,reason:result.reason};}

async function validateLedger(input:unknown):Promise<Ledger>{
  const row=object(snapshotEffectData(input));exact(row,['schema','revision','commands','effects','sha256']);
  if(row.schema!=='RBRIDGE_EFFECT_LEDGER_V1'||typeof row.revision!=='number'||!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.sha256!=='string'||!SHA.test(row.sha256)||!Array.isArray(row.commands)||!Array.isArray(row.effects))fail('RBRIDGE_EFFECT_LEDGER_INVALID');
  if(new TextEncoder().encode(canonicalJson(row)).byteLength>LEDGER_BYTES)fail('RBRIDGE_EFFECT_LEDGER_INVALID');
  const commands:CommandRecord[]=[],effects:EffectRecord[]=[],ids=new Set<string>(),effectIds=new Set<string>();
  for(const inputRecord of row.commands){
    const record=object(inputRecord);exact(record,['command','result']);const command=await parseEffectCommand(record.command,WIRE_BYTES);
    if(ids.has(command.commandId))fail('RBRIDGE_EFFECT_LEDGER_INVALID');ids.add(command.commandId);
    const result=record.result===null?null:await parseEffectResult(record.result,command,WIRE_BYTES);commands.push({command,result});
  }
  for(const inputRecord of row.effects){
    const record=object(inputRecord);exact(record,['effectId','requestDigest','executeCommandId','outcome','result']);
    if(typeof record.effectId!=='string'||!SHA.test(record.effectId)||typeof record.requestDigest!=='string'||!SHA.test(record.requestDigest)||typeof record.executeCommandId!=='string'||effectIds.has(record.effectId))fail('RBRIDGE_EFFECT_LEDGER_INVALID');effectIds.add(record.effectId);
    const original=commands.find(value=>value.command.commandId===record.executeCommandId);
    if(!original||original.command.action!=='EXECUTE'||original.command.request.effectId!==record.effectId||original.command.request.requestDigest!==record.requestDigest||!same(record.result,original.result))fail('RBRIDGE_EFFECT_LEDGER_INVALID');
    const outcome=original.result===null?pendingEffectOutcome(original.command.request):observation(original.result);
    if(!same(record.outcome,outcome))fail('RBRIDGE_EFFECT_LEDGER_INVALID');
    effects.push({effectId:record.effectId,requestDigest:record.requestDigest,executeCommandId:record.executeCommandId,outcome,result:original.result});
  }
  for(const record of commands){
    const effect=effects.find(value=>value.effectId===record.command.request.effectId);
    if(record.command.action==='EXECUTE'&&!effect)fail('RBRIDGE_EFFECT_LEDGER_INVALID');
    if(effect){
      const original=commands.find(value=>value.command.commandId===effect.executeCommandId)!;
      // A read reserved before any EXECUTE owns only its command identity.
      // Missing or interrupted read observations cannot bind the future effect.
      const independentRead=record.command.action==='RECONCILE'&&(record.result===null||
        (record.result.state==='BLOCKED'&&record.result.reason==='RBRIDGE_EFFECT_NOT_FOUND'&&record.result.receipt===null));
      if(!same(original.command.request,record.command.request)&&!independentRead)fail('RBRIDGE_EFFECT_LEDGER_INVALID');
    }
  }
  const body={schema:'RBRIDGE_EFFECT_LEDGER_V1' as const,revision:row.revision,commands,effects};
  if(await canonicalDigest(body)!==row.sha256)fail('RBRIDGE_EFFECT_LEDGER_INVALID');return {...body,sha256:row.sha256};
}
function extendsLedger(prior:Ledger,next:Ledger):void{
  if(next.revision<prior.revision||(next.revision===prior.revision&&next.sha256!==prior.sha256))fail('RBRIDGE_EFFECT_LEDGER_INVALID');
  for(const record of prior.commands){const fresh=next.commands.find(value=>value.command.commandId===record.command.commandId);if(!fresh||!same(fresh.command,record.command)||(record.result!==null&&!same(fresh.result,record.result)))fail('RBRIDGE_EFFECT_LEDGER_INVALID');}
  for(const record of prior.effects){const fresh=next.effects.find(value=>value.effectId===record.effectId);if(!fresh||fresh.requestDigest!==record.requestDigest||fresh.executeCommandId!==record.executeCommandId||(record.result!==null&&!same(fresh,record)))fail('RBRIDGE_EFFECT_LEDGER_INVALID');}
}

export class RbridgeEffectStoreV1{
  private readonly authority:Authority;
  constructor(private readonly storage:ChromeStorageAreaV1){this.authority=authority(storage);}

  async reserve(input:RbridgeChatEffectCommandV1):Promise<'NEW'|'REPLAY'>{
    const snapshot=snapshotEffectData(input);
    return await this.exclusive(async()=>{
      const command=await parseEffectCommand(snapshot,WIRE_BYTES),current=await this.load();
      const prior=current?.commands.find(value=>value.command.commandId===command.commandId);
      if(prior){if(!same(prior.command,command))fail('REQUEST_ID_COLLISION');return 'REPLAY';}
      const effect=current?.effects.find(value=>value.effectId===command.request.effectId);
      if(effect){const original=current!.commands.find(value=>value.command.commandId===effect.executeCommandId)!;if(!same(original.command.request,command.request))fail('REQUEST_ID_COLLISION');}
      const isNew=command.action==='EXECUTE'&&!effect;
      if(isNew&&current?.effects.some(value=>value.outcome.state==='UNCERTAIN'||value.outcome.state==='APPLIED_UNVERIFIED'))fail('RBRIDGE_EFFECT_ACTIVE_UNRESOLVED');
      const commands=[...(current?.commands??[]),{command,result:null}],effects=[...(current?.effects??[])];
      if(isNew)effects.push({effectId:command.request.effectId,requestDigest:command.request.requestDigest,executeCommandId:command.commandId,outcome:pendingEffectOutcome(command.request),result:null});
      await this.write(current,commands,effects);return isNew?'NEW':'REPLAY';
    });
  }
  async read(effectId:string,requestDigest:string):Promise<{request:CocwinRbridgeEffectRequestV1;outcome:EffectExecutionV3;result:RbridgeChatEffectResultV1|null}|null>{
    if(!SHA.test(effectId)||!SHA.test(requestDigest))fail('RBRIDGE_EFFECT_LOOKUP_INVALID');
    const current=await this.load(),effect=current?.effects.find(value=>value.effectId===effectId);if(!effect)return null;
    if(effect.requestDigest!==requestDigest)fail('REQUEST_ID_COLLISION');const original=current!.commands.find(value=>value.command.commandId===effect.executeCommandId)!;
    return snapshotEffectData({request:original.command.request,outcome:effect.outcome,result:effect.result});
  }
  // Browser capture reads the original reserved request; content supplies no authority fields.
  async requestForEffect(effectId:string):Promise<CocwinRbridgeEffectRequestV1|null>{
    if(!SHA.test(effectId))fail('RBRIDGE_EFFECT_LOOKUP_INVALID');
    const current=await this.load(),effect=current?.effects.find(value=>value.effectId===effectId);
    if(!effect)return null;
    return snapshotEffectData(current!.commands.find(value=>value.command.commandId===effect.executeCommandId)!.command.request);
  }
  async saveResult(input:RbridgeChatEffectResultV1):Promise<void>{
    const snapshot=snapshotEffectData(input);
    await this.exclusive(async()=>{
      const current=await this.load(),record=current?.commands.find(value=>value.command.commandId===snapshot.commandId);if(!current||!record)fail('RBRIDGE_EFFECT_COMMAND_NOT_RESERVED');
      const result=await parseEffectResult(snapshot,record.command,WIRE_BYTES);
      if(record.result!==null){if(!same(record.result,result))fail('REQUEST_ID_COLLISION');return;}
      const commands=current.commands.map(value=>value===record?{command:record.command,result}:value),effects=current.effects.map(value=>value.executeCommandId===result.commandId?{...value,outcome:observation(result),result}:value);
      await this.write(current,commands,effects);
    });
  }
  async getCommand(input:RbridgeChatEffectCommandV1):Promise<CommandRecord|null>{
    const command=snapshotEffectData(input),current=await this.load(),record=current?.commands.find(value=>value.command.commandId===command.commandId);if(!record)return null;
    if(!same(record.command,command))fail('REQUEST_ID_COLLISION');return snapshotEffectData(record);
  }
  // These process-local gates never release a remote mutation on timeout.
  assertMutationAvailable():void{
    if(this.authority.poisoned)fail('RBRIDGE_EFFECT_STORAGE_UNAVAILABLE');
  }
  enqueueMutation<T>(run:()=>Promise<T>):Promise<T>{
    const result=this.authority.mutations.then(run);this.authority.mutations=result.then(()=>undefined,()=>undefined);return result;
  }
  async dispatchOnce(input:RbridgeChatEffectCommandV1,run:(snapshot:RbridgeChatEffectCommandV1)=>Promise<RbridgeChatEffectResultV1>):Promise<RbridgeChatEffectResultV1>{
    const command=snapshotEffectData(input),fingerprint=canonicalJson(command),prior=this.authority.pending.get(command.commandId);
    if(prior){if(prior.fingerprint!==fingerprint)fail('REQUEST_ID_COLLISION');return snapshotEffectData(await prior.result);}
    const result=run(command);this.authority.pending.set(command.commandId,{fingerprint,result});
    try{return snapshotEffectData(await result);}finally{this.authority.pending.delete(command.commandId);}
  }
  private async exclusive<T>(run:()=>Promise<T>):Promise<T>{
    const result=this.authority.writes.then(()=>{if(this.authority.poisoned)fail('RBRIDGE_EFFECT_STORAGE_UNAVAILABLE');return run();});this.authority.writes=result.then(()=>undefined,()=>undefined);return await result;
  }
  private async load():Promise<Ledger|null>{
    if(this.authority.poisoned)fail('RBRIDGE_EFFECT_STORAGE_UNAVAILABLE');const floor=this.authority.seen;
    try{
      const stored=await this.storage.get(KEY),value=stored[KEY];
      if(value===undefined){if(floor)fail('RBRIDGE_EFFECT_LEDGER_MISSING');return null;}
      let ledger:Ledger;try{ledger=await validateLedger(value);}catch{fail('RBRIDGE_EFFECT_LEDGER_INVALID');}
      if(floor)extendsLedger(floor,ledger);
      if(!this.authority.seen||ledger.revision>this.authority.seen.revision)this.authority.seen=snapshotEffectData(ledger);
      return ledger;
    }catch(error){this.authority.poisoned=true;if(error instanceof Error&&/^RBRIDGE_EFFECT_LEDGER_(?:INVALID|MISSING)$/.test(error.message))throw error;fail('RBRIDGE_EFFECT_STORAGE_UNAVAILABLE');}
  }
  private async write(current:Ledger|null,commands:CommandRecord[],effects:EffectRecord[]):Promise<void>{
    const revision=(current?.revision??0)+1;if(!Number.isSafeInteger(revision))fail('RBRIDGE_EFFECT_LEDGER_FULL');
    const body={schema:'RBRIDGE_EFFECT_LEDGER_V1' as const,revision,commands,effects},next:Ledger={...body,sha256:await canonicalDigest(body)};
    if(new TextEncoder().encode(canonicalJson(next)).byteLength>LEDGER_BYTES)fail('RBRIDGE_EFFECT_LEDGER_FULL');
    // Reject an invalid transition before publishing any durable bytes.
    await validateLedger(next);this.assertMutationAvailable();
    try{
      await this.storage.set({[KEY]:snapshotEffectData(next)});
      const readback=await this.storage.get(KEY);if(!same(readback[KEY],next))fail('RBRIDGE_EFFECT_WRITE_UNCERTAIN');
      await validateLedger(readback[KEY]);this.authority.seen=snapshotEffectData(next);
    }catch{this.authority.poisoned=true;fail('RBRIDGE_EFFECT_WRITE_UNCERTAIN');}
  }
}
