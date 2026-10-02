import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {canonicalDigest,canonicalJson,parseEffectCommand,parseEffectResult,parseV3Scope,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope} from '../domain/rbridgeEffectProtocol.js';

export interface RbridgeEffectResultStoreOptionsV3 {
  eventStoreRoot:string;
  scope:V3Scope;
  maxMessageBytes:number;
  maxRecords?:number;
  maxBytes?:number;
}
interface Entry {command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1|null}
interface Journal {schema:'RBRIDGE_NATIVE_V3_RESULT_JOURNAL_V1';appId:string;revision:number;entries:Entry[];sha256:string}
interface Authority {schema:'RBRIDGE_NATIVE_V3_RESULT_AUTHORITY_V1';appId:string;sha256:string}
const queues=new Map<string,Promise<void>>();
function fail(code:string):never{throw Error(code);}
function errno(error:unknown):string|undefined{return (error as NodeJS.ErrnoException)?.code;}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(row,k)))fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
  return row;
}
function snapshot(input:unknown):unknown {
  const seen=new WeakSet<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(depth>32)fail('RBRIDGE_NATIVE_RESULT_INPUT_INVALID');
    if(value===null||['string','number','boolean'].includes(typeof value))return;
    if(typeof value!=='object'||seen.has(value as object))fail('RBRIDGE_NATIVE_RESULT_INPUT_INVALID');
    const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&proto!==Array.prototype)fail('RBRIDGE_NATIVE_RESULT_INPUT_INVALID');
    seen.add(value as object);
    for(const key of Reflect.ownKeys(value as object)){
      if(typeof key!=='string')fail('RBRIDGE_NATIVE_RESULT_INPUT_INVALID');
      const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(!Object.prototype.hasOwnProperty.call(property,'value'))fail('RBRIDGE_NATIVE_RESULT_INPUT_INVALID');
      visit(property.value,depth+1);
    }
    seen.delete(value as object);
  };
  visit(input,0);return structuredClone(input);
}
function currentUid():number|undefined{return typeof process.getuid==='function'?process.getuid():undefined;}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function samePath(a:string,b:string):boolean{return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
function scopeMatches(command:RbridgeChatEffectCommandV1,scope:V3Scope):boolean{return (['appId','baseSha','sessionId','generation'] as const).every(k=>command.request[k]===scope[k]);}
function commandId(value:unknown):string{
  if(typeof value!=='string'||!/^[-A-Za-z0-9_.:]{1,192}$/.test(value))fail('RBRIDGE_NATIVE_RESULT_COMMAND_ID_INVALID');
  return value;
}

/** Durable wire evidence only. Transport/HELLO authentication and browser execution remain separate. */
export class RbridgeEffectResultStoreV3 {
  private readonly parent:string;
  private readonly root:string;
  private readonly scope:V3Scope;
  private readonly ceiling:number;
  private readonly maxRecords:number;
  private readonly maxBytes:number;
  private faulted=false;

  constructor(options:RbridgeEffectResultStoreOptionsV3){
    if(typeof options.eventStoreRoot!=='string'||!isAbsolute(options.eventStoreRoot)||resolve(options.eventStoreRoot)!==options.eventStoreRoot||/[\0\r\n]/.test(options.eventStoreRoot))fail('RBRIDGE_NATIVE_RESULT_ROOT_INVALID');
    try{this.scope=parseV3Scope(options.scope);}catch{fail('RBRIDGE_NATIVE_RESULT_CONFIG_INVALID');}
    this.ceiling=options.maxMessageBytes;this.maxRecords=options.maxRecords??4096;this.maxBytes=options.maxBytes??8*1024*1024;
    if(!Number.isSafeInteger(this.ceiling)||this.ceiling<4096||this.ceiling>65536||!Number.isSafeInteger(this.maxRecords)||this.maxRecords<1||this.maxRecords>4096||!Number.isSafeInteger(this.maxBytes)||this.maxBytes<4096||this.maxBytes>64*1024*1024)fail('RBRIDGE_NATIVE_RESULT_CONFIG_INVALID');
    this.parent=options.eventStoreRoot;this.root=join(this.parent,'v3-results');
  }
  get eventStoreRoot():string{return this.parent;}
  get appId():string{return this.scope.appId;}
  /** Holds the journal writer gate while admitting a peer. Existing unbound history needs explicit migration proof. */
  async admitPeerOwner<T>(admit:(hasHistory:boolean)=>Promise<T>):Promise<T>{
    return this.exclusive(async()=>{const journal=await this.load();return admit(journal.revision!==0);});
  }

  private async directory(path:string,create:boolean):Promise<void>{
    if(create)await mkdir(path,{mode:0o700}).catch(error=>{if(errno(error)!=='EEXIST')throw error;});
    const info=await lstat(path);
    if(!info.isDirectory()||info.isSymbolicLink()||!privateMode(info.mode)||(currentUid()!==undefined&&info.uid!==currentUid())||!samePath(await realpath(path),path))fail('RBRIDGE_NATIVE_RESULT_ROOT_INVALID');
  }
  private async ensureRoot():Promise<void>{
    // The established V1 event root is a prerequisite. Do not create untracked ancestors.
    await this.directory(this.parent,false);await this.directory(this.root,true);
    // Always repeat the containing-directory barrier, including after a failed first attempt.
    await this.syncDirectory(this.parent);
  }
  private async syncDirectory(path:string):Promise<void>{
    if(process.platform==='win32')return;
    const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await handle.sync();}finally{await handle.close();}
  }
  private async syncRoot():Promise<void>{await this.syncDirectory(this.root);}
  private async file(name:string):Promise<string|null>{
    let handle;
    try{handle=await open(join(this.root,name),constants.O_RDONLY|constants.O_NOFOLLOW|(process.platform==='win32'?0:constants.O_NONBLOCK));}
    catch(error){if(errno(error)==='ENOENT')return null;fail('RBRIDGE_NATIVE_RESULT_READ_FAILED');}
    try{
      const before=await handle.stat();
      if(!before.isFile()||before.nlink!==1||!privateMode(before.mode)||(currentUid()!==undefined&&before.uid!==currentUid())||before.size<2||before.size>this.maxBytes)fail('RBRIDGE_NATIVE_RESULT_FILE_INVALID');
      const bytes=await handle.readFile();const after=await handle.stat();
      if(after.size!==before.size||after.nlink!==1||bytes.length!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('RBRIDGE_NATIVE_RESULT_FILE_INVALID');
      try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');}
    }finally{await handle.close();}
  }
  private async authority():Promise<Authority|null>{
    const text=await this.file('authority.json');if(text===null)return null;
    try{
      const row=exact(JSON.parse(text),['schema','appId','sha256']);
      if(row.schema!=='RBRIDGE_NATIVE_V3_RESULT_AUTHORITY_V1'||typeof row.appId!=='string'||typeof row.sha256!=='string'||text!==canonicalJson(row)+'\n'||row.sha256!==await canonicalDigest({schema:row.schema,appId:row.appId}))fail('RBRIDGE_NATIVE_RESULT_AUTHORITY_INVALID');
      if(row.appId!==this.scope.appId)fail('RBRIDGE_NATIVE_RESULT_OWNER_MISMATCH');
      return row as unknown as Authority;
    }catch(error){if(error instanceof Error&&error.message==='RBRIDGE_NATIVE_RESULT_OWNER_MISMATCH')throw error;fail('RBRIDGE_NATIVE_RESULT_AUTHORITY_INVALID');}
  }
  private async load():Promise<Journal>{
    const authority=await this.authority(),text=await this.file('journal.json');
    if(text===null){if(authority!==null)fail('RBRIDGE_NATIVE_RESULT_JOURNAL_MISSING');return {schema:'RBRIDGE_NATIVE_V3_RESULT_JOURNAL_V1',appId:this.scope.appId,revision:0,entries:[],sha256:''};}
    if(authority===null)fail('RBRIDGE_NATIVE_RESULT_AUTHORITY_MISSING');
    try{
      const row=exact(JSON.parse(text),['schema','appId','revision','entries','sha256']);
      if(row.schema!=='RBRIDGE_NATIVE_V3_RESULT_JOURNAL_V1'||row.appId!==this.scope.appId||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||!Array.isArray(row.entries)||row.entries.length>this.maxRecords||text!==canonicalJson(row)+'\n')fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
      const {sha256,...body}=row;if(typeof sha256!=='string'||sha256!==await canonicalDigest(body))fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
      const ids=new Set<string>(),entries:Entry[]=[];
      for(const input of row.entries){
        const record=exact(input,['command','result']),command=await parseEffectCommand(record.command,this.ceiling);
        commandId(command.commandId);
        if(command.request.appId!==this.scope.appId||ids.has(command.commandId))fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
        ids.add(command.commandId);
        const result=record.result===null?null:await parseEffectResult(record.result,command,this.ceiling);
        entries.push({command,result});
      }
      return {...row,entries} as unknown as Journal;
    }catch{fail('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');}
  }
  private async createAuthority():Promise<void>{
    const body={schema:'RBRIDGE_NATIVE_V3_RESULT_AUTHORITY_V1',appId:this.scope.appId};
    const text=canonicalJson({...body,sha256:await canonicalDigest(body)})+'\n';
    const handle=await open(join(this.root,'authority.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    await this.syncRoot();
  }
  private async persist(journal:Journal):Promise<void>{
    if(journal.revision>=Number.MAX_SAFE_INTEGER)fail('RBRIDGE_NATIVE_RESULT_RECORD_LIMIT');
    const body={schema:journal.schema,appId:journal.appId,revision:journal.revision+1,entries:journal.entries};
    const next={...body,sha256:await canonicalDigest(body)},text=canonicalJson(next)+'\n';
    if(Buffer.byteLength(text)>this.maxBytes)fail('RBRIDGE_NATIVE_RESULT_BYTE_LIMIT');
    const temp='.journal-'+randomBytes(16).toString('hex')+'.tmp',path=join(this.root,temp);
    try{
      if(journal.revision===0)await this.createAuthority();
      await this.directory(this.parent,false);await this.directory(this.root,false);
      const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
      await rename(path,join(this.root,'journal.json'));await this.syncRoot();
      const readback=await this.load();if(canonicalJson(readback)!==canonicalJson(next))fail('RBRIDGE_NATIVE_RESULT_READBACK_MISMATCH');
    }catch{this.faulted=true;fail('RBRIDGE_NATIVE_RESULT_WRITE_UNCERTAIN');}
    finally{await unlink(path).catch(error=>{if(errno(error)!=='ENOENT')this.faulted=true;});}
  }
  private requireResultHeadroom(journal:Journal):void{
    // A validated result's complete canonical JSON is <= the negotiated wire ceiling.
    // Reserve that upper bound for every unresolved result, including revision digit growth.
    const maximum={schema:journal.schema,appId:journal.appId,revision:Number.MAX_SAFE_INTEGER,entries:journal.entries,sha256:'0'.repeat(64)};
    const remaining=journal.entries.filter(entry=>entry.result===null).length*(this.ceiling-4);
    if(Buffer.byteLength(canonicalJson(maximum)+'\n')+remaining>this.maxBytes)fail('RBRIDGE_NATIVE_RESULT_BYTE_LIMIT');
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    const key=process.platform==='win32'?this.root.toLowerCase():this.root;
    const previous=queues.get(key)??Promise.resolve();let release!:()=>void;
    const admission=new Promise<void>(r=>{release=r;});queues.set(key,admission);await previous;
    let lock:Awaited<ReturnType<typeof open>>|undefined;
    let identity:{ino:number;dev:number}|undefined;
    try{
      if(this.faulted)fail('RBRIDGE_NATIVE_RESULT_STORE_FAULTED');await this.ensureRoot();
      try{lock=await open(join(this.root,'writer.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if(errno(error)==='EEXIST')fail('RBRIDGE_NATIVE_RESULT_WRITER_BUSY');throw error;}
      const info=await lock.stat();if(!info.isFile()||info.nlink!==1||!privateMode(info.mode)||(currentUid()!==undefined&&info.uid!==currentUid()))fail('RBRIDGE_NATIVE_RESULT_FILE_INVALID');
      identity={ino:info.ino,dev:info.dev};await lock.writeFile(randomBytes(16).toString('hex')+'\n');await lock.sync();
      return await fn();
    }finally{
      try{
        if(lock){await lock.close();const info=await lstat(join(this.root,'writer.lock'));
          if(!identity||!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.ino!==identity.ino||info.dev!==identity.dev){this.faulted=true;fail('RBRIDGE_NATIVE_RESULT_LOCK_CHANGED');}
          await unlink(join(this.root,'writer.lock'));await this.syncRoot();
        }
      }finally{release();if(queues.get(key)===admission)queues.delete(key);}
    }
  }

  async reserve(input:unknown):Promise<RbridgeChatEffectCommandV1>{
    const immutable=snapshot(input);
    return this.exclusive(async()=>{
      const command=await parseEffectCommand(immutable,this.ceiling);commandId(command.commandId);
      if(!scopeMatches(command,this.scope))fail('RBRIDGE_NATIVE_RESULT_SCOPE_MISMATCH');
      const journal=await this.load(),existing=journal.entries.find(row=>row.command.commandId===command.commandId);
      if(existing){if(canonicalJson(existing.command)!==canonicalJson(command))fail('REQUEST_ID_COLLISION');return structuredClone(existing.command);}
      if(journal.entries.length>=this.maxRecords)fail('RBRIDGE_NATIVE_RESULT_RECORD_LIMIT');
      journal.entries.push({command,result:null});this.requireResultHeadroom(journal);await this.persist(journal);return structuredClone(command);
    });
  }
  async record(input:unknown):Promise<RbridgeChatEffectResultV1>{
    return this.recordEvidence(input,true);
  }
  /** Archives a previously reserved complete result without granting the current generation authority. */
  async recordRetained(input:unknown):Promise<RbridgeChatEffectResultV1>{
    return this.recordEvidence(input,false);
  }
  private async recordEvidence(input:unknown,current:boolean):Promise<RbridgeChatEffectResultV1>{
    const immutable=snapshot(input),id=commandId((immutable as {commandId?:unknown})?.commandId);
    return this.exclusive(async()=>{
      const journal=await this.load(),entry=journal.entries.find(row=>row.command.commandId===id);
      if(!entry)fail('RBRIDGE_NATIVE_RESULT_COMMAND_MISSING');
      if(current&&!scopeMatches(entry.command,this.scope))fail('RBRIDGE_NATIVE_RESULT_SCOPE_MISMATCH');
      const result=await parseEffectResult(immutable,entry.command,this.ceiling);
      if(entry.result){if(canonicalJson(entry.result)!==canonicalJson(result))fail('REQUEST_ID_COLLISION');return structuredClone(entry.result);}
      entry.result=result;await this.persist(journal);return structuredClone(result);
    });
  }
  async read(id:string):Promise<Entry|null>{
    commandId(id);return this.exclusive(async()=>{const entry=(await this.load()).entries.find(row=>row.command.commandId===id);return entry&&scopeMatches(entry.command,this.scope)?structuredClone(entry):null;});
  }
  /** Complete reserved historical command, only for authenticated transport correlation. */
  async readRetained(id:string):Promise<Entry|null>{
    commandId(id);return this.exclusive(async()=>{const entry=(await this.load()).entries.find(row=>row.command.commandId===id);return entry?structuredClone(entry):null;});
  }
  /** Includes retained old-generation evidence for transport journaling; it grants no current-session authority. */
  async replay():Promise<RbridgeChatEffectResultV1[]>{return this.exclusive(async()=>structuredClone((await this.load()).entries.flatMap(row=>row.result?[row.result]:[])));}
}
