import {constants as fsConstants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {
  M0_LIMITS,canonicalDigest,canonicalJson,
  type CocwinReceiptRefV1,type RbridgeChatBindingReceiptV1,type RbridgeChatCaptureReceiptV1,type RbridgeChatSendReceiptV1,
} from '../domain/rbridgeChatCore.js';

export type RbridgeReceiptV1=RbridgeChatBindingReceiptV1|RbridgeChatSendReceiptV1|RbridgeChatCaptureReceiptV1;

export interface RbridgeReceiptStoreConfigV1 {
  root:string;
  maxReceipts?:number;
  maxBytes?:number;
}

const DEFAULT_MAX_RECEIPTS=8192;
const DEFAULT_MAX_BYTES=16*1024*1024;
const SHA256=/^[0-9a-f]{64}$/;
const SESSION=/^exta-[0-9a-f]{32}$/;
const GENERATION=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTEMPT=/^exta-[0-9a-f]{32}:a:[1-9][0-9]*$/;
function fail(code:string):never{throw new Error(code);}
function cloneReceipt(value:RbridgeReceiptV1):RbridgeReceiptV1{return structuredClone(value);}
function row(value:unknown,code:string):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail(code);
  return value as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:readonly string[],code:string):void{
  const expected=new Set(keys);
  if(Object.keys(value).length!==expected.size||Object.keys(value).some(key=>!expected.has(key)))fail(code);
}
function text(value:unknown,max:number,code:string):string{
  if(typeof value!=='string'||value.length===0||Buffer.byteLength(value,'utf8')>max||value.includes('\0'))fail(code);
  return value;
}
function integer(value:unknown,min:number,max:number,code:string):number{
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);
  return value;
}
function iso(value:unknown):string{
  if(typeof value!=='string')fail('RBRIDGE_RECEIPT_TIME_INVALID');
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail('RBRIDGE_RECEIPT_TIME_INVALID');
  return value;
}
function sha(value:unknown,code:string):string{if(typeof value!=='string'||!SHA256.test(value))fail(code);return value;}
function session(value:unknown):string{if(typeof value!=='string'||!SESSION.test(value))fail('RBRIDGE_RECEIPT_SESSION_INVALID');return value;}
function generation(value:unknown):string{if(typeof value!=='string'||!GENERATION.test(value))fail('RBRIDGE_RECEIPT_GENERATION_INVALID');return value;}
function attempt(value:unknown,sessionId:string):string{
  if(typeof value!=='string'||!ATTEMPT.test(value)||!value.startsWith(sessionId+':a:'))fail('RBRIDGE_RECEIPT_ATTEMPT_INVALID');
  return value;
}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function samePath(a:string,b:string):boolean{
  const left=resolve(a),right=resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}

async function validateDigest<T extends Record<string,unknown>>(value:T):Promise<void>{
  const declared=sha(value.sha256,'RBRIDGE_RECEIPT_SHA_INVALID');
  const body:Record<string,unknown>={};
  for(const [key,item] of Object.entries(value))if(key!=='sha256')body[key]=item;
  if(await canonicalDigest(body)!==declared)fail('RBRIDGE_RECEIPT_DIGEST_INVALID');
}

export async function validateRbridgeReceiptV1(input:unknown):Promise<RbridgeReceiptV1>{
  const value=row(input,'RBRIDGE_RECEIPT_INVALID');
  const schema=value.schema;
  if(schema==='RBRIDGE_CHAT_BINDING_RECEIPT_V1'){
    exact(value,['schema','receiptId','sessionId','generation','browserInstanceId','browserProfileId','windowId','tabId','origin','projectId','conversationId','conversationGeneration','ownerSessionId','writeLeaderEpoch','captureEpoch','observedAt','sha256'],'RBRIDGE_BINDING_RECEIPT_FIELDS_INVALID');
    const out={
      schema,receiptId:text(value.receiptId,512,'RBRIDGE_RECEIPT_ID_INVALID'),
      sessionId:session(value.sessionId),generation:generation(value.generation),
      browserInstanceId:text(value.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),
      browserProfileId:text(value.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
      windowId:integer(value.windowId,0,2147483647,'RBRIDGE_WINDOW_ID_INVALID'),
      tabId:integer(value.tabId,0,2147483647,'RBRIDGE_TAB_ID_INVALID'),
      origin:text(value.origin,512,'RBRIDGE_ORIGIN_INVALID'),
      projectId:text(value.projectId,256,'RBRIDGE_PROJECT_ID_INVALID'),
      conversationId:text(value.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
      conversationGeneration:integer(value.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
      ownerSessionId:session(value.ownerSessionId),
      writeLeaderEpoch:integer(value.writeLeaderEpoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),
      captureEpoch:integer(value.captureEpoch,0,2147483647,'RBRIDGE_CAPTURE_EPOCH_INVALID'),
      observedAt:iso(value.observedAt),sha256:sha(value.sha256,'RBRIDGE_RECEIPT_SHA_INVALID'),
    } satisfies RbridgeChatBindingReceiptV1;
    await validateDigest(out as unknown as Record<string,unknown>);return out;
  }
  if(schema==='RBRIDGE_CHAT_SEND_RECEIPT_V1'){
    exact(value,['schema','receiptId','sessionId','generation','attemptId','effectId','challenge','purpose','transactionState','conversationId','conversationGeneration','writeLeaderEpoch','observedAt','sha256'],'RBRIDGE_SEND_RECEIPT_FIELDS_INVALID');
    const sessionId=session(value.sessionId);
    if(value.purpose!=='PROMPT'&&value.purpose!=='RESULT')fail('RBRIDGE_SEND_PURPOSE_INVALID');
    if(value.transactionState!=='FAILED_BEFORE_CLICK'&&value.transactionState!=='UNCERTAIN'&&value.transactionState!=='SENT_VERIFIED'&&value.transactionState!=='STOPPED'&&value.transactionState!=='SUPERSEDED')fail('RBRIDGE_SEND_RECEIPT_STATE_INVALID');
    const out={
      schema,receiptId:text(value.receiptId,512,'RBRIDGE_RECEIPT_ID_INVALID'),sessionId,generation:generation(value.generation),
      attemptId:attempt(value.attemptId,sessionId),effectId:sha(value.effectId,'RBRIDGE_EFFECT_ID_INVALID'),challenge:sha(value.challenge,'RBRIDGE_CHALLENGE_INVALID'),
      purpose:value.purpose,transactionState:value.transactionState,
      conversationId:text(value.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
      conversationGeneration:integer(value.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
      writeLeaderEpoch:integer(value.writeLeaderEpoch,0,2147483647,'RBRIDGE_WRITE_LEADER_EPOCH_INVALID'),
      observedAt:iso(value.observedAt),sha256:sha(value.sha256,'RBRIDGE_RECEIPT_SHA_INVALID'),
    } satisfies RbridgeChatSendReceiptV1;
    await validateDigest(out as unknown as Record<string,unknown>);return out;
  }
  if(schema==='RBRIDGE_CHAT_CAPTURE_RECEIPT_V1'){
    exact(value,['schema','receiptId','sessionId','generation','attemptId','effectId','challenge','conversationId','conversationGeneration','assistantTurnId','responseUtf8Bytes','machineBlockSha256','captureEpoch','observedAt','sha256'],'RBRIDGE_CAPTURE_RECEIPT_FIELDS_INVALID');
    const sessionId=session(value.sessionId);
    const machineBlockSha256=value.machineBlockSha256===null?null:sha(value.machineBlockSha256,'RBRIDGE_MACHINE_BLOCK_SHA_INVALID');
    const out={
      schema,receiptId:text(value.receiptId,512,'RBRIDGE_RECEIPT_ID_INVALID'),sessionId,generation:generation(value.generation),
      attemptId:attempt(value.attemptId,sessionId),effectId:sha(value.effectId,'RBRIDGE_EFFECT_ID_INVALID'),challenge:sha(value.challenge,'RBRIDGE_CHALLENGE_INVALID'),
      conversationId:text(value.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
      conversationGeneration:integer(value.conversationGeneration,1,2147483647,'RBRIDGE_CONVERSATION_GENERATION_INVALID'),
      assistantTurnId:text(value.assistantTurnId,256,'RBRIDGE_ASSISTANT_TURN_ID_INVALID'),
      responseUtf8Bytes:integer(value.responseUtf8Bytes,0,M0_LIMITS.maxAssistantTurnUtf8Bytes,'RBRIDGE_RESPONSE_SIZE_INVALID'),
      machineBlockSha256,captureEpoch:integer(value.captureEpoch,0,2147483647,'RBRIDGE_CAPTURE_EPOCH_INVALID'),
      observedAt:iso(value.observedAt),sha256:sha(value.sha256,'RBRIDGE_RECEIPT_SHA_INVALID'),
    } satisfies RbridgeChatCaptureReceiptV1;
    await validateDigest(out as unknown as Record<string,unknown>);return out;
  }
  fail('RBRIDGE_RECEIPT_SCHEMA_INVALID');
}

export class RbridgeReceiptStoreV1 {
  private readonly root:string;
  private readonly path:string;
  private readonly maxReceipts:number;
  private readonly maxBytes:number;
  private loaded=false;
  private bytes=0;
  private receipts=new Map<string,RbridgeReceiptV1>();
  private queue:Promise<void>=Promise.resolve();

  constructor(config:RbridgeReceiptStoreConfigV1){
    if(typeof config.root!=='string'||!isAbsolute(config.root)||resolve(config.root)!==config.root||config.root.includes('\0'))fail('RBRIDGE_RECEIPT_STORE_ROOT_INVALID');
    this.maxReceipts=config.maxReceipts??DEFAULT_MAX_RECEIPTS;
    this.maxBytes=config.maxBytes??DEFAULT_MAX_BYTES;
    if(!Number.isInteger(this.maxReceipts)||this.maxReceipts<1||this.maxReceipts>100000)fail('RBRIDGE_RECEIPT_STORE_COUNT_LIMIT_INVALID');
    if(!Number.isInteger(this.maxBytes)||this.maxBytes<4096||this.maxBytes>64*1024*1024)fail('RBRIDGE_RECEIPT_STORE_BYTE_LIMIT_INVALID');
    this.root=config.root;this.path=join(config.root,'receipts.ndjson');
  }

  private async ensureRoot():Promise<void>{
    await mkdir(this.root,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(this.root,0o700);
    const info=await lstat(this.root);if(info.isSymbolicLink()||!info.isDirectory()||!privateMode(info.mode))fail('RBRIDGE_RECEIPT_STORE_ROOT_INVALID');
    if(!samePath(await realpath(this.root),this.root))fail('RBRIDGE_RECEIPT_STORE_ROOT_INVALID');
  }

  private async loadUnsafe():Promise<void>{
    if(this.loaded)return;
    await this.ensureRoot();
    let data:Buffer;
    try{
      const info=await lstat(this.path);
      if(info.isSymbolicLink()||!info.isFile()||!privateMode(info.mode)||info.size>this.maxBytes)fail('RBRIDGE_RECEIPT_STORE_FILE_INVALID');
      data=await readFile(this.path);
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT'){this.loaded=true;return;}
      throw error;
    }
    if(data.byteLength===0){this.loaded=true;return;}
    if(data[data.byteLength-1]!==0x0a)fail('RBRIDGE_RECEIPT_STORE_TRUNCATED');
    const lines=data.toString('utf8').split('\n');lines.pop();
    if(lines.length>this.maxReceipts)fail('RBRIDGE_RECEIPT_STORE_COUNT_LIMIT_EXCEEDED');
    const receipts=new Map<string,RbridgeReceiptV1>();
    for(const line of lines){
      let parsed:unknown;try{parsed=JSON.parse(line);}catch{fail('RBRIDGE_RECEIPT_STORE_JSON_INVALID');}
      const receipt=await validateRbridgeReceiptV1(parsed);
      if(receipts.has(receipt.receiptId))fail('RBRIDGE_RECEIPT_STORE_DUPLICATE_ID');
      receipts.set(receipt.receiptId,receipt);
    }
    this.receipts=receipts;this.bytes=data.byteLength;this.loaded=true;
  }

  async get(receiptId:string):Promise<RbridgeReceiptV1|null>{
    await this.queue;await this.loadUnsafe();
    const value=this.receipts.get(text(receiptId,512,'RBRIDGE_RECEIPT_ID_INVALID'));return value?cloneReceipt(value):null;
  }

  async put(input:unknown):Promise<CocwinReceiptRefV1>{
    let release!:()=>void;const before=this.queue;
    this.queue=new Promise<void>(resolve=>{release=resolve;});await before;
    try{
      await this.loadUnsafe();
      const receipt=await validateRbridgeReceiptV1(input);
      const existing=this.receipts.get(receipt.receiptId);
      if(existing){
        if(existing.sha256!==receipt.sha256)fail('REQUEST_ID_COLLISION');
        return {schema:'COCWIN_RECEIPT_REF_V1',receiptId:existing.receiptId,receiptSchema:existing.schema,sha256:existing.sha256};
      }
      if(this.receipts.size>=this.maxReceipts)fail('RBRIDGE_RECEIPT_STORE_COUNT_LIMIT_EXCEEDED');
      const line=canonicalJson(receipt)+'\n',lineBytes=Buffer.byteLength(line,'utf8');
      if(this.bytes+lineBytes>this.maxBytes)fail('RBRIDGE_RECEIPT_STORE_BYTE_LIMIT_EXCEEDED');
      await this.ensureRoot();
      const handle=await open(this.path,fsConstants.O_CREAT|fsConstants.O_APPEND|fsConstants.O_WRONLY|fsConstants.O_NOFOLLOW,0o600)
        .catch(()=>fail('RBRIDGE_RECEIPT_STORE_OPEN_FAILED'));
      try{await handle.writeFile(line,'utf8');await handle.sync();}
      catch(error){throw error instanceof Error&&error.message.startsWith('RBRIDGE_')?error:new Error('RBRIDGE_RECEIPT_STORE_WRITE_UNCERTAIN');}
      finally{await handle.close().catch(()=>{});}
      if(process.platform!=='win32')await chmod(this.path,0o600);
      this.receipts.set(receipt.receiptId,receipt);this.bytes+=lineBytes;
      return {schema:'COCWIN_RECEIPT_REF_V1',receiptId:receipt.receiptId,receiptSchema:receipt.schema,sha256:receipt.sha256};
    }finally{release();}
  }
}
