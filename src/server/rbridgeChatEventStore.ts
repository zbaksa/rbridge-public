import {constants as fsConstants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {canonicalJson,type RbridgeChatEventV1,validateEventEnvelope} from '../domain/rbridgeChatCore.js';

export interface RbridgeChatEventStoreConfig{
  root:string;
  maxEvents?:number;
  maxBytes?:number;
}
const DEFAULT_MAX_EVENTS=4096;
const DEFAULT_MAX_BYTES=8*1024*1024;
function fail(code:string):never{throw new Error(code);}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function samePath(a:string,b:string):boolean{
  const left=resolve(a),right=resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}

export class RbridgeChatEventStoreV1{
  private readonly root:string;
  private readonly path:string;
  private readonly maxEvents:number;
  private readonly maxBytes:number;
  private loaded=false;
  private events:RbridgeChatEventV1[]=[];
  private byId=new Map<string,RbridgeChatEventV1>();
  private bytes=0;
  private queue:Promise<void>=Promise.resolve();

  constructor(config:RbridgeChatEventStoreConfig){
    if(typeof config.root!=='string'||!isAbsolute(config.root)||config.root.includes('\0')||resolve(config.root)!==config.root)fail('RBRIDGE_EVENT_STORE_ROOT_INVALID');
    const maxEvents=config.maxEvents??DEFAULT_MAX_EVENTS,maxBytes=config.maxBytes??DEFAULT_MAX_BYTES;
    if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>100_000)fail('RBRIDGE_EVENT_STORE_EVENT_LIMIT_INVALID');
    if(!Number.isInteger(maxBytes)||maxBytes<4096||maxBytes>64*1024*1024)fail('RBRIDGE_EVENT_STORE_BYTE_LIMIT_INVALID');
    this.root=config.root;this.path=join(config.root,'events.ndjson');this.maxEvents=maxEvents;this.maxBytes=maxBytes;
  }

  private async ensureRoot():Promise<void>{
    await mkdir(this.root,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(this.root,0o700);
    const info=await lstat(this.root);if(info.isSymbolicLink()||!info.isDirectory()||!privateMode(info.mode))fail('RBRIDGE_EVENT_STORE_ROOT_INVALID');
    const actual=await realpath(this.root);if(!samePath(actual,this.root))fail('RBRIDGE_EVENT_STORE_ROOT_INVALID');
  }

  private async loadUnsafe():Promise<void>{
    if(this.loaded)return;
    await this.ensureRoot();
    let data:Buffer;
    try{
      const info=await lstat(this.path);
      if(info.isSymbolicLink()||!info.isFile()||!privateMode(info.mode)||info.size>this.maxBytes)fail('RBRIDGE_EVENT_STORE_FILE_INVALID');
      data=await readFile(this.path);
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT'){this.loaded=true;return;}
      throw error;
    }
    if(data.byteLength===0){this.loaded=true;return;}
    if(data[data.byteLength-1]!==0x0a)fail('RBRIDGE_EVENT_STORE_TRUNCATED');
    const text=data.toString('utf8'),lines=text.split('\n');lines.pop();
    if(lines.length>this.maxEvents)fail('RBRIDGE_EVENT_STORE_EVENT_LIMIT_EXCEEDED');
    const events:RbridgeChatEventV1[]=[],byId=new Map<string,RbridgeChatEventV1>();
    for(let i=0;i<lines.length;i++){
      let parsed:unknown;try{parsed=JSON.parse(lines[i]!);}catch{fail('RBRIDGE_EVENT_STORE_JSON_INVALID');}
      const previous=events.at(-1)?.eventSha256??null;
      const event=await validateEventEnvelope(parsed,previous,i+1);
      if(i===0&&event.previousEventSha256!==null)fail('RBRIDGE_EVENT_STORE_CHAIN_INVALID');
      if(byId.has(event.eventId))fail('RBRIDGE_EVENT_STORE_DUPLICATE_EVENT');
      events.push(event);byId.set(event.eventId,event);
    }
    this.events=events;this.byId=byId;this.bytes=data.byteLength;this.loaded=true;
  }

  async load():Promise<readonly RbridgeChatEventV1[]>{
    await this.queue;
    await this.loadUnsafe();
    return [...this.events];
  }

  async append(eventInput:RbridgeChatEventV1):Promise<RbridgeChatEventV1>{
    let resolveQueue!:()=>void;
    const previousQueue=this.queue;
    this.queue=new Promise<void>(resolve=>{resolveQueue=resolve;});
    await previousQueue;
    try{
      await this.loadUnsafe();
      const existing=this.byId.get(eventInput.eventId);
      if(existing){
        if(existing.eventSha256!==eventInput.eventSha256)fail('REQUEST_ID_COLLISION');
        return existing;
      }
      if(this.events.length>=this.maxEvents)fail('RBRIDGE_EVENT_STORE_EVENT_LIMIT_EXCEEDED');
      const previous=this.events.at(-1)?.eventSha256??null,nextSequence=this.events.length+1;
      const event=await validateEventEnvelope(eventInput,previous,nextSequence);
      if(nextSequence===1&&event.previousEventSha256!==null)fail('RBRIDGE_EVENT_STORE_CHAIN_INVALID');
      const line=canonicalJson(event)+'\n',lineBytes=Buffer.byteLength(line);
      if(this.bytes+lineBytes>this.maxBytes)fail('RBRIDGE_EVENT_STORE_BYTE_LIMIT_EXCEEDED');
      await this.ensureRoot();
      const handle=await open(this.path,fsConstants.O_CREAT|fsConstants.O_APPEND|fsConstants.O_WRONLY|fsConstants.O_NOFOLLOW,0o600)
        .catch(()=>fail('RBRIDGE_EVENT_STORE_OPEN_FAILED'));
      try{
        const info=await handle.stat();if(!info.isFile()||!privateMode(info.mode))fail('RBRIDGE_EVENT_STORE_FILE_INVALID');
        await handle.writeFile(line,'utf8');await handle.sync();
      }catch(error){
        throw error instanceof Error&&error.message.startsWith('RBRIDGE_')?error:new Error('RBRIDGE_EVENT_STORE_WRITE_UNCERTAIN');
      }finally{await handle.close().catch(()=>{});}
      if(process.platform!=='win32')await chmod(this.path,0o600);
      this.events.push(event);this.byId.set(event.eventId,event);this.bytes+=lineBytes;return event;
    }finally{resolveQueue();}
  }
}
