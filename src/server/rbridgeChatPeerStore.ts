import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {parseHello,validateEventEnvelope,type RbridgeChatEventV1} from '../domain/rbridgeChatCore.js';
import {canonicalDigest,canonicalJson,parseEffectCommand,parseV3Scope,requireV3Peer,sha256Hex,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope,type VerifiedPeerV3} from '../domain/rbridgeEffectProtocol.js';
import {NativeV3PeerAuthority,type NativeV3HistoryAnchor} from '../nativeHost/nativeV3PeerAuthority.js';
import {RbridgeEffectResultStoreV3} from '../nativeHost/rbridgeEffectResultStore.js';
import {snapshotNativeMessage} from '../nativeHost/nativeHostProtocol.js';
import {RbridgeChatEventStoreV1} from './rbridgeChatEventStore.js';

export interface RbridgeChatPeerConfigV3 {schema:'RBRIDGE_CHAT_PEER_CONFIG_V3';scope:V3Scope;peerPins:VerifiedPeerV3;initialHistory:NativeV3HistoryAnchor}
export interface RbridgeChatCommandCommitV1 {schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1';commandId:string;commandSha256:string;requestDigest:string;transferSha256:string;totalBytes:number;chunkCount:number}
export interface RbridgeChatCommandChunkV1 extends Omit<RbridgeChatCommandCommitV1,'schema'> {schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1';index:number;offset:number;dataBase64:string}
interface Transfer {commit:RbridgeChatCommandCommitV1;chunks:(string|null)[]}
interface CommandEntry {command:RbridgeChatEffectCommandV1;state:'QUEUED'|'DISPATCHED'}
interface Journal {schema:'RBRIDGE_CHAT_PEER_JOURNAL_V3';appId:string;peerPinsSha256:string;revision:number;transfers:Transfer[];commands:CommandEntry[];sha256:string}
interface Channel {schema:'RBRIDGE_CHAT_PEER_CHANNEL_V3';channelId:string;pid:number;processStart:string;scope:V3Scope;peerPins:VerifiedPeerV3;updatedAt:number;sha256:string}
interface Context {config:RbridgeChatPeerConfigV3;events:RbridgeChatEventStoreV1;results:RbridgeEffectResultStoreV3;authority:NativeV3PeerAuthority;journal:Journal}
const queues=new Map<string,Promise<void>>();
const MAX_BYTES=8*1024*1024,MAX_TRANSFERS=128,MAX_COMMANDS=4096,CHUNK_BYTES=3072,CHANNEL_TTL_MS=5000;
const COMMIT_FIELDS=['schema','commandId','commandSha256','requestDigest','transferSha256','totalBytes','chunkCount'] as const;
function fail(code:string):never{throw Error(code);}
function errno(e:unknown):string|undefined{return (e as NodeJS.ErrnoException)?.code;}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function uid():number|undefined{return typeof process.getuid==='function'?process.getuid():undefined;}
function exact(input:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_PEER_FIELDS_INVALID');
  const row=input as Record<string,unknown>;if(Object.keys(row).length!==keys.length||keys.some(k=>!Object.hasOwn(row,k)))fail('RBRIDGE_PEER_FIELDS_INVALID');return row;
}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}
function sameScope(command:RbridgeChatEffectCommandV1,scope:V3Scope):boolean{return (['appId','baseSha','sessionId','generation'] as const).every(k=>command.request[k]===scope[k]);}
function commandId(input:unknown):string{if(typeof input!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input))fail('RBRIDGE_PEER_COMMAND_ID_INVALID');return input;}
function commit(input:unknown):RbridgeChatCommandCommitV1{
  const row=exact(input,COMMIT_FIELDS);if(row.schema!=='RBRIDGE_CHAT_COMMAND_COMMIT_V1')fail('RBRIDGE_PEER_SCHEMA_INVALID');commandId(row.commandId);
  for(const k of ['commandSha256','requestDigest','transferSha256'])if(typeof row[k]!=='string'||! /^[a-f0-9]{64}$/.test(row[k] as string))fail('RBRIDGE_PEER_DIGEST_INVALID');
  if(!Number.isSafeInteger(row.totalBytes)||Number(row.totalBytes)<2||Number(row.totalBytes)>65536||row.chunkCount!==Math.ceil(Number(row.totalBytes)/CHUNK_BYTES))fail('RBRIDGE_PEER_CHUNK_BUDGET_INVALID');
  return row as unknown as RbridgeChatCommandCommitV1;
}
function chunk(input:unknown):RbridgeChatCommandChunkV1{
  const row=exact(input,[...COMMIT_FIELDS,'index','offset','dataBase64']);if(row.schema!=='RBRIDGE_CHAT_COMMAND_CHUNK_V1')fail('RBRIDGE_PEER_SCHEMA_INVALID');
  const {index,offset,dataBase64,...body}=row;const c=commit({...body,schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1'});
  if(!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=c.chunkCount||offset!==Number(index)*CHUNK_BYTES||typeof dataBase64!=='string'||Buffer.byteLength(dataBase64)>4096)fail('RBRIDGE_PEER_CHUNK_INVALID');
  const decoded=Buffer.from(dataBase64,'base64'),size=Math.min(CHUNK_BYTES,c.totalBytes-Number(offset));
  if(decoded.length!==size||decoded.toString('base64')!==dataBase64)fail('RBRIDGE_PEER_CHUNK_INVALID');return row as unknown as RbridgeChatCommandChunkV1;
}
async function processStart(pid:number):Promise<string>{
  if(process.platform!=='linux')return String(pid);
  const text=await readFile('/proc/'+pid+'/stat','utf8'),value=text.slice(text.lastIndexOf(')')+2).split(' ')[19];
  if(!value||! /^[0-9]+$/.test(value))fail('RBRIDGE_PEER_PROCESS_INVALID');return value;
}

/** Private app-owned spool. The fixed installed channel, not a wire digest, supplies peer authentication. */
export class RbridgeChatPeerStoreV3 {
  private readonly root:string;
  private readonly dataRoot:string;
  private channelId:string|null=null;
  private faulted=false;
  constructor(root:string){
    if(!isAbsolute(root)||resolve(root)!==root||/[\0\r\n]/.test(root))fail('RBRIDGE_PEER_ROOT_INVALID');this.root=root;this.dataRoot=join(root,'v3-peer');
  }
  private async directory(path:string,create=false):Promise<void>{
    if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(errno(e)!=='EEXIST')throw e;});
    const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||!privateMode(info.mode)||(uid()!==undefined&&info.uid!==uid()))fail('RBRIDGE_PEER_PRIVATE_ROOT_INVALID');
    const actual=await realpath(path);if(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path)fail('RBRIDGE_PEER_PRIVATE_ROOT_INVALID');
  }
  private async sync(path:string):Promise<void>{
    if(process.platform==='win32')return;const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}
  }
  private async file(path:string,max:number):Promise<string|null>{
    let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|(process.platform==='win32'?0:constants.O_NONBLOCK));}catch(e){if(errno(e)==='ENOENT')return null;fail('RBRIDGE_PEER_PRIVATE_FILE_INVALID');}
    try{
      const before=await handle.stat();if(!before.isFile()||before.nlink!==1||!privateMode(before.mode)||(uid()!==undefined&&before.uid!==uid())||before.size<2||before.size>max)fail('RBRIDGE_PEER_PRIVATE_FILE_INVALID');
      const bytes=await handle.readFile(),after=await handle.stat();if(bytes.length!==before.size||after.size!==before.size||after.nlink!==1||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('RBRIDGE_PEER_PRIVATE_FILE_INVALID');
      try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('RBRIDGE_PEER_JSON_INVALID');}
    }finally{await handle.close();}
  }
  private async atomic(name:string,text:string):Promise<void>{
    await this.directory(this.root);await this.directory(this.dataRoot);const temp=join(this.dataRoot,'.'+randomBytes(16).toString('hex')+'.tmp');
    try{const handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await rename(temp,join(this.dataRoot,name));await this.sync(this.dataRoot);if(await this.file(join(this.dataRoot,name),MAX_BYTES)!==text)fail('RBRIDGE_PEER_READBACK_MISMATCH');}
    catch{this.faulted=true;fail('RBRIDGE_PEER_WRITE_UNCERTAIN');}finally{await unlink(temp).catch(e=>{if(errno(e)!=='ENOENT')this.faulted=true;});}
  }
  private async config():Promise<RbridgeChatPeerConfigV3>{
    await this.directory(this.root);const text=await this.file(join(this.root,'v3-peer-config.json'),16384);if(text===null)fail('RBRIDGE_PEER_CONFIG_UNAVAILABLE');
    let row:Record<string,unknown>;try{row=exact(JSON.parse(text),['schema','scope','peerPins','initialHistory']);}catch{fail('RBRIDGE_PEER_CONFIG_INVALID');}
    if(row.schema!=='RBRIDGE_CHAT_PEER_CONFIG_V3'||text!==canonicalJson(row)+'\n')fail('RBRIDGE_PEER_CONFIG_INVALID');const scope=parseV3Scope(row.scope);
    const pins=exact(row.peerPins,['peerId','releaseSha','browserInstanceId','browserProfileId','protocolMinor','maxMessageBytes','capabilities']) as unknown as VerifiedPeerV3;requireV3Peer(pins);
    exact(row.initialHistory,['sequence','eventSha256']);return {...row,scope,peerPins:pins} as unknown as RbridgeChatPeerConfigV3;
  }
  private async journal(config:RbridgeChatPeerConfigV3):Promise<Journal>{
    const owner={schema:'RBRIDGE_CHAT_PEER_AUTHORITY_V3',appId:config.scope.appId,peerPinsSha256:await canonicalDigest(config.peerPins)},ownerText=canonicalJson({...owner,sha256:await canonicalDigest(owner)})+'\n';
    const marker=await this.file(join(this.dataRoot,'authority.json'),16384),text=await this.file(join(this.dataRoot,'journal.json'),MAX_BYTES);
    if(marker!==null&&marker!==ownerText)fail('RBRIDGE_PEER_OWNER_PIN_MISMATCH');
    if(text===null){if(marker!==null)fail('RBRIDGE_PEER_JOURNAL_MISSING');return {schema:'RBRIDGE_CHAT_PEER_JOURNAL_V3',appId:owner.appId,peerPinsSha256:owner.peerPinsSha256,revision:0,transfers:[],commands:[],sha256:''};}
    if(marker===null)fail('RBRIDGE_PEER_AUTHORITY_MISSING');let row:Record<string,unknown>;try{row=exact(JSON.parse(text),['schema','appId','peerPinsSha256','revision','transfers','commands','sha256']);}catch{fail('RBRIDGE_PEER_JOURNAL_INVALID');}
    const {sha256,...body}=row;if(row.schema!=='RBRIDGE_CHAT_PEER_JOURNAL_V3'||row.appId!==owner.appId||row.peerPinsSha256!==owner.peerPinsSha256||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||text!==canonicalJson(row)+'\n'||sha256!==await canonicalDigest(body)||!Array.isArray(row.transfers)||row.transfers.length>MAX_TRANSFERS||!Array.isArray(row.commands)||row.commands.length>MAX_COMMANDS)fail('RBRIDGE_PEER_JOURNAL_INVALID');
    const ids=new Set<string>();for(const entry of row.transfers){const t=exact(entry,['commit','chunks']),c=commit(t.commit);if(ids.has(c.commandId)||!Array.isArray(t.chunks)||t.chunks.length!==c.chunkCount)fail('RBRIDGE_PEER_JOURNAL_INVALID');ids.add(c.commandId);for(let i=0;i<t.chunks.length;i++)if(t.chunks[i]!==null)chunk({...c,schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1',index:i,offset:i*CHUNK_BYTES,dataBase64:t.chunks[i]});}
    ids.clear();for(const entry of row.commands){const e=exact(entry,['command','state']),c=await parseEffectCommand(e.command,config.peerPins.maxMessageBytes);if(c.request.appId!==owner.appId||ids.has(c.commandId)||!['QUEUED','DISPATCHED'].includes(String(e.state)))fail('RBRIDGE_PEER_JOURNAL_INVALID');ids.add(c.commandId);}
    return row as unknown as Journal;
  }
  private budget(journal:Journal):void{if(journal.commands.length>MAX_COMMANDS||journal.transfers.length>MAX_TRANSFERS||Buffer.byteLength(canonicalJson({...journal,revision:Number.MAX_SAFE_INTEGER,sha256:'0'.repeat(64)})+'\n')>MAX_BYTES)fail('RBRIDGE_PEER_SPOOL_BUDGET_EXCEEDED');}
  private async persist(journal:Journal):Promise<void>{
    if(journal.revision>=Number.MAX_SAFE_INTEGER)fail('RBRIDGE_PEER_REVISION_LIMIT');this.budget(journal);
    if(journal.revision===0){const owner={schema:'RBRIDGE_CHAT_PEER_AUTHORITY_V3',appId:journal.appId,peerPinsSha256:journal.peerPinsSha256},text=canonicalJson({...owner,sha256:await canonicalDigest(owner)})+'\n';const handle=await open(join(this.dataRoot,'authority.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await this.sync(this.dataRoot);}
    const {sha256:prior,...body}=journal;void prior;body.revision++;const next={...body,sha256:await canonicalDigest(body)};await this.atomic('journal.json',canonicalJson(next)+'\n');Object.assign(journal,next);
  }
  private async exclusive<T>(fn:(context:Context)=>Promise<T>):Promise<T>{
    const key=process.platform==='win32'?this.dataRoot.toLowerCase():this.dataRoot,prior=queues.get(key)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});queues.set(key,gate);await prior;
    let lock:Awaited<ReturnType<typeof open>>|undefined,identity:{ino:number;dev:number}|undefined;
    try{
      if(this.faulted)fail('RBRIDGE_PEER_STORE_FAULTED');const config=await this.config();await this.directory(this.dataRoot,true);await this.sync(this.root);
      try{lock=await open(join(this.dataRoot,'writer.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if(errno(e)==='EEXIST')fail('RBRIDGE_PEER_WRITER_BUSY');throw e;}
      const info=await lock.stat();identity={ino:info.ino,dev:info.dev};await lock.writeFile(randomBytes(16).toString('hex')+'\n');await lock.sync();
      // Recreate the V1 reader per operation so cross-process appends are never hidden by a cached cursor.
      const events=new RbridgeChatEventStoreV1({root:this.root}),results=new RbridgeEffectResultStoreV3({eventStoreRoot:this.root,scope:config.scope,maxMessageBytes:config.peerPins.maxMessageBytes}),authority=new NativeV3PeerAuthority({eventStoreRoot:this.root,appId:config.scope.appId,peerPins:config.peerPins,initialHistory:config.initialHistory});
      const eventFile=await this.file(join(this.root,'events.ndjson'),MAX_BYTES);void eventFile;await authority.initialize(events,results);
      return await fn({config,events,results,authority,journal:await this.journal(config)});
    }finally{
      try{if(lock){await lock.close();const now=await lstat(join(this.dataRoot,'writer.lock'));if(!now.isFile()||now.nlink!==1||!identity||now.ino!==identity.ino||now.dev!==identity.dev)fail('RBRIDGE_PEER_LOCK_IDENTITY_CHANGED');await unlink(join(this.dataRoot,'writer.lock'));await this.sync(this.dataRoot);}}
      finally{release();if(queues.get(key)===gate)queues.delete(key);}
    }
  }
  private async channel(context:Context,owned=false):Promise<Channel>{
    const text=await this.file(join(this.dataRoot,'channel.json'),16384);if(text===null)fail('RBRIDGE_PEER_NOT_NEGOTIATED');let row:Record<string,unknown>;try{row=exact(JSON.parse(text),['schema','channelId','pid','processStart','scope','peerPins','updatedAt','sha256']);}catch{fail('RBRIDGE_PEER_CHANNEL_INVALID');}
    const {sha256,...body}=row;if(row.schema!=='RBRIDGE_CHAT_PEER_CHANNEL_V3'||typeof row.channelId!=='string'||! /^[a-f0-9]{32}$/.test(row.channelId)||!Number.isSafeInteger(row.pid)||Number(row.pid)<1||typeof row.processStart!=='string'||!Number.isSafeInteger(row.updatedAt)||text!==canonicalJson(row)+'\n'||sha256!==await canonicalDigest(body)||!same(row.peerPins,context.config.peerPins)||!same(row.scope,context.config.scope))fail('RBRIDGE_PEER_CHANNEL_CHANGED');
    const age=Date.now()-Number(row.updatedAt);if(age<0||age>CHANNEL_TTL_MS)fail('RBRIDGE_PEER_UNAVAILABLE');try{process.kill(Number(row.pid),0);if(await processStart(Number(row.pid))!==row.processStart)fail('RBRIDGE_PEER_UNAVAILABLE');}catch{fail('RBRIDGE_PEER_UNAVAILABLE');}
    if(owned&&this.channelId!==row.channelId)fail('RBRIDGE_PEER_CHANNEL_CHANGED');return row as unknown as Channel;
  }
  private async saveChannel(channel:Omit<Channel,'sha256'>):Promise<void>{await this.atomic('channel.json',canonicalJson({...channel,sha256:await canonicalDigest(channel)})+'\n');}
  async peer():Promise<VerifiedPeerV3>{return this.exclusive(async c=>structuredClone((await this.channel(c)).peerPins));}
  async heartbeat():Promise<void>{return this.exclusive(async c=>{const {sha256,...channel}=await this.channel(c,true);void sha256;channel.updatedAt=Date.now();await this.saveChannel(channel);});}
  async disconnect():Promise<void>{return this.exclusive(async()=>{if(this.channelId===null)return;const text=await this.file(join(this.dataRoot,'channel.json'),16384);if(text!==null&&JSON.parse(text).channelId===this.channelId){await unlink(join(this.dataRoot,'channel.json'));await this.sync(this.dataRoot);}this.channelId=null;});}
  async stageChunk(input:unknown):Promise<void>{
    const immutable=snapshotNativeMessage(input,8192),data=chunk(immutable);return this.exclusive(async c=>{
      await this.channel(c);if(data.totalBytes>c.config.peerPins.maxMessageBytes)fail('OUTPUT_BUDGET_EXCEEDED');const {index,offset,dataBase64,...body}=data;void offset;const descriptor=commit({...body,schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1'});
      let transfer=c.journal.transfers.find(t=>t.commit.commandId===data.commandId);if(transfer&&!same(transfer.commit,descriptor))fail('REQUEST_ID_COLLISION');
      if(!transfer){transfer={commit:descriptor,chunks:Array.from({length:data.chunkCount},()=>null)};c.journal.transfers.push(transfer);}
      const old=transfer.chunks[index];if(old!==null){if(old!==dataBase64)fail('REQUEST_ID_COLLISION');return;}
      transfer.chunks[index]=dataBase64;await this.persist(c.journal);
    });
  }
  async commitCommand(input:unknown):Promise<void>{
    const immutable=snapshotNativeMessage(input,2048),descriptor=commit(immutable);return this.exclusive(async c=>{
      await this.channel(c);const t=c.journal.transfers.find(t=>t.commit.commandId===descriptor.commandId);if(!t||t.chunks.some(x=>x===null))fail('PARTIAL_COMMAND_UNCERTAIN');if(!same(t.commit,descriptor))fail('REQUEST_ID_COLLISION');
      const bytes=Buffer.concat(t.chunks.map(x=>Buffer.from(x!,'base64')));if(bytes.length!==descriptor.totalBytes||await sha256Hex(bytes)!==descriptor.transferSha256)fail('RBRIDGE_PEER_TRANSFER_DIGEST_MISMATCH');
      let text:string,input:unknown;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);input=JSON.parse(text);}catch{fail('RBRIDGE_PEER_COMMAND_JSON_INVALID');}
      const command=await parseEffectCommand(input,c.config.peerPins.maxMessageBytes);if(canonicalJson(command)!==text||command.commandId!==descriptor.commandId||command.commandSha256!==descriptor.commandSha256||command.request.requestDigest!==descriptor.requestDigest)fail('RBRIDGE_PEER_COMMAND_IDENTITY_MISMATCH');
      await this.enqueueValidated(command,c.config.scope,c);
    });
  }
  async enqueue(input:RbridgeChatEffectCommandV1,scopeInput:V3Scope):Promise<void>{
    const immutable=snapshotNativeMessage(input,65536),scope=parseV3Scope(scopeInput);return this.exclusive(async c=>{await this.channel(c);await this.enqueueValidated(await parseEffectCommand(immutable,c.config.peerPins.maxMessageBytes),scope,c);});
  }
  private async enqueueValidated(command:RbridgeChatEffectCommandV1,scope:V3Scope,c:Context):Promise<void>{
    if(!same(scope,c.config.scope)||!sameScope(command,scope))fail('RBRIDGE_PEER_SCOPE_MISMATCH');c.authority.validateTarget(command.request.payload.target);
    const old=c.journal.commands.find(e=>e.command.commandId===command.commandId);if(old){if(!same(old.command,command))fail('REQUEST_ID_COLLISION');return;}
    // Generation changes retain uncertain old sends; a later authenticated result is stored, never relabelled.
    if(command.action==='EXECUTE')for(const e of c.journal.commands){if(e.command.action==='EXECUTE'&&!sameScope(e.command,scope)&&['RBRIDGE_SEND','RBRIDGE_RESULT_SEND'].includes(e.command.request.effectKind)){const r=(await c.results.readRetained(e.command.commandId))?.result;if(!r||!['VERIFIED','FAILED_SAFE'].includes(r.state))fail('RBRIDGE_PEER_PENDING_OLD_SEND');}}
    c.journal.commands.push({command,state:'QUEUED'});this.budget(c.journal);await c.results.reserve(command);await this.persist(c.journal);
  }
  async takeForDispatch():Promise<RbridgeChatEffectCommandV1|null>{return this.exclusive(async c=>{await this.channel(c,true);const entry=c.journal.commands.find(e=>e.state==='QUEUED'&&sameScope(e.command,c.config.scope));if(!entry)return null;entry.state='DISPATCHED';await this.persist(c.journal);await this.channel(c,true);return structuredClone(entry.command);});}
  async recordIncoming(input:unknown,peerInput:VerifiedPeerV3):Promise<void>{
    const immutable=snapshotNativeMessage(input,65536),peer=snapshotNativeMessage(peerInput,16384) as VerifiedPeerV3;return this.exclusive(async c=>{
      requireV3Peer(peer);if(!same(peer,c.config.peerPins))fail('RBRIDGE_PEER_PIN_MISMATCH');const schema=(immutable as {schema?:unknown})?.schema;
      if(schema==='RBRIDGE_CHAT_HELLO_V1'){
        const hello=parseHello(immutable);c.authority.validateHello(hello);try{const active=await this.channel(c);if(active.channelId!==this.channelId)fail('RBRIDGE_PEER_CHANNEL_BUSY');}catch(e){if(!(e instanceof Error)||!['RBRIDGE_PEER_NOT_NEGOTIATED','RBRIDGE_PEER_UNAVAILABLE'].includes(e.message))throw e;}
        const id=this.channelId??randomBytes(16).toString('hex');await this.saveChannel({schema:'RBRIDGE_CHAT_PEER_CHANNEL_V3',channelId:id,pid:process.pid,processStart:await processStart(process.pid),scope:c.config.scope,peerPins:c.config.peerPins,updatedAt:Date.now()});this.channelId=id;return;
      }
      await this.channel(c,true);if(Buffer.byteLength(canonicalJson(immutable))>c.config.peerPins.maxMessageBytes)fail('OUTPUT_BUDGET_EXCEEDED');
      if(schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1'){await c.results.recordRetained(immutable);return;}
      if(schema==='RBRIDGE_CHAT_EVENT_V1'){
        const event=await validateEventEnvelope(immutable),known=event.sessionId===c.config.scope.sessionId&&event.generation===c.config.scope.generation||c.journal.commands.some(e=>e.command.request.sessionId===event.sessionId&&e.command.request.generation===event.generation);if(!known)fail('RBRIDGE_PEER_EVENT_SCOPE_MISMATCH');
        await c.events.append(event);await this.sync(this.root);const persisted=new RbridgeChatEventStoreV1({root:this.root});if(!(await persisted.load()).some(e=>same(e,event)))fail('RBRIDGE_PEER_EVENT_READBACK_MISMATCH');return;
      }
      fail('RBRIDGE_PEER_SCHEMA_DENIED');
    });
  }
  async read(id:string,scopeInput:V3Scope):Promise<{result:RbridgeChatEffectResultV1|null;events:RbridgeChatEventV1[]}>{
    commandId(id);const scope=parseV3Scope(scopeInput);return this.exclusive(async c=>{if(scope.appId!==c.config.scope.appId)fail('RBRIDGE_PEER_OWNER_SCOPE_MISMATCH');await this.channel(c);const entry=await c.results.readRetained(id);if(!entry||!sameScope(entry.command,scope))return {result:null,events:[]};return {result:entry.result,events:(await c.events.load()).filter(e=>e.sessionId===scope.sessionId&&e.generation===scope.generation)};});
  }
  async readEvent(afterSequence:number):Promise<RbridgeChatEventV1|null>{
    if(!Number.isSafeInteger(afterSequence)||afterSequence<0)fail('RBRIDGE_PEER_EVENT_CURSOR_INVALID');return this.exclusive(async c=>{await this.channel(c);const events=await c.events.load();if(afterSequence>events.length)fail('RBRIDGE_EVENT_SEQUENCE_GAP');const event=events[afterSequence];if(!event)return null;if(Buffer.byteLength(canonicalJson(event))>c.config.peerPins.maxMessageBytes)fail('OUTPUT_BUDGET_EXCEEDED');return structuredClone(event);});
  }
}
