import {opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {RBRIDGE_CORE_LIMITS as limits} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import type {RBridgeExecutionJournal} from './rbridgeExecutionJournal.js';
import {freezeRBridgeValue} from './rbridgeExecutionPolicy.js';
import {createRBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
import {createRBridgeStateFiles,rbridgeStateFdPath,type RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeGitHubDeliveryIdentity{repository:string;issueNumber:number;authorLogin:string;title:string;bodySha256:string;requestSha256:string;operationId:string;intentSha256:string;}
export interface RBridgeGitHubDeliveryRecordV1{schema:'RBRIDGE_GITHUB_DELIVERY_V1';revision:number;identity:RBridgeGitHubDeliveryIdentity;state:'PENDING'|'PUBLISHED'|'IDENTITY_BLOCKED';publication?:{envelopeSha256:string;totalBytes:number;chunkCount:number;nextIndex:number;manifestCommentId?:number;receiptCommentId?:number};lastReason:string;attempts:number;}
export interface RBridgeDeliveryJournal{get(issueNumber:number):Promise<RBridgeGitHubDeliveryRecordV1|undefined>;claim(identity:RBridgeGitHubDeliveryIdentity):Promise<RBridgeGitHubDeliveryRecordV1>;update(issueNumber:number,expectedRevision:number,next:RBridgeGitHubDeliveryRecordV1):Promise<RBridgeGitHubDeliveryRecordV1>;pending(limit:number):Promise<readonly RBridgeGitHubDeliveryRecordV1[]>;}
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=integer.min(1),hash=z.string().regex(/^[a-f0-9]{64}$/),operationId=z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const utf8=(max:number)=>z.string().refine(s=>!s.includes('\0')&&Buffer.byteLength(s)<=max);
const identitySchema=z.strictObject({repository:z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),issueNumber:positive,authorLogin:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),title:utf8(1024),bodySha256:hash,requestSha256:hash,operationId,intentSha256:hash});
const publicationSchema=z.strictObject({envelopeSha256:hash,totalBytes:positive.max(limits.outputBytes+limits.recordBytes),chunkCount:integer.max(256),nextIndex:integer,manifestCommentId:positive.optional(),receiptCommentId:positive.optional()}).refine(v=>v.nextIndex<=v.chunkCount);
const recordSchema=z.strictObject({schema:z.literal('RBRIDGE_GITHUB_DELIVERY_V1'),revision:positive,identity:identitySchema,state:z.enum(['PENDING','PUBLISHED','IDENTITY_BLOCKED']),publication:publicationSchema.optional(),lastReason:utf8(512),attempts:integer});
function fail(code='RBRIDGE_DELIVERY_INVALID'):never{throw new Error(code);}
function issue(value:number){if(!Number.isSafeInteger(value)||value<1)fail();return value;}
const canonical=(value:unknown)=>canonicalRBridgeJson(value as RBridgeJsonValue);
function record(value:unknown,issueNumber:number):RBridgeGitHubDeliveryRecordV1{
  assertBoundedRBridgeJson(value,{bytes:limits.recordBytes,depth:limits.depth,nodes:8192});const parsed=recordSchema.parse(value);if(parsed.identity.issueNumber!==issueNumber)fail();
  return freezeRBridgeValue(JSON.parse(JSON.stringify(parsed)) as RBridgeGitHubDeliveryRecordV1);
}
export async function createRBridgeDeliveryJournal(options:{root:string;journal:RBridgeExecutionJournal;files?:RBridgeStateFiles}):Promise<RBridgeDeliveryJournal>{
  const {root,journal}=options,files=options.files??createRBridgeStateFiles(),uid=process.getuid?.(),serializer=createRBridgeOperationSerializer();
  if(uid===undefined||uid<1||process.geteuid?.()!==uid)fail();await files.validateTree(root,uid);
  const dir=join(root,'deliveries/github'),path=(issueNumber:number)=>join(dir,`${issue(issueNumber)}.json`);
  async function get(issueNumber:number):Promise<RBridgeGitHubDeliveryRecordV1|undefined>{
    try{const bytes=await files.read(path(issueNumber),uid!,limits.recordBytes),parsed=record(JSON.parse(bytes.toString('utf8')),issueNumber);if(bytes.toString('utf8')!==canonical(parsed))fail();return parsed;}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return undefined;throw error;}
  }
  async function scan(limit:number):Promise<readonly RBridgeGitHubDeliveryRecordV1[]>{
    const handle=await files.directory(dir,uid!,true),pending:RBridgeGitHubDeliveryRecordV1[]=[];let entries=0;
    try{
      const directory=await opendir(rbridgeStateFdPath(handle));
      for await(const entry of directory){
        if(++entries>limits.stateEntryLimit)fail('RBRIDGE_CORE_CAPACITY_REACHED');
        if(!/^[1-9][0-9]*\.json$/.test(entry.name)){const h=await files.file(join(dir,entry.name),uid!,limits.journalBytes);await h.close();continue;}
        const current=await get(Number(entry.name.slice(0,-5)));if(!current)fail();if(current.state==='PENDING'&&pending.length<limit)pending.push(current);
      }
      return pending;
    }finally{await handle.close();}
  }
  async function commit(next:RBridgeGitHubDeliveryRecordV1,createOnly:boolean){
    const number=next.identity.issueNumber,data=Buffer.from(canonical(next));await journal.reserveDelivery(number);
    try{await files.commit(path(number),data,uid!,createOnly);await journal.accountDeliveryCommit(number,data.length);}
    catch(error){await journal.rescanAccounting(number).catch(()=>undefined);throw error;}
    return next;
  }
  await scan(0);
  return {
    get,
    async claim(identity){
      assertBoundedRBridgeJson(identity);const checked=identitySchema.parse(identity),number=checked.issueNumber;
      return serializer.run(String(number),async()=>{
        const previous=await get(number);if(previous){if(canonical(previous.identity)!==canonical(checked))fail('RBRIDGE_DELIVERY_IDENTITY_COLLISION');return previous;}
        return commit(record({schema:'RBRIDGE_GITHUB_DELIVERY_V1',revision:1,identity:checked,state:'PENDING',lastReason:'RBRIDGE_DELIVERY_PENDING',attempts:0},number),true);
      });
    },
    async update(number,expectedRevision,nextValue){
      issue(number);return serializer.run(String(number),async()=>{
        const previous=await get(number),next=record(nextValue,number);
        if(!previous||previous.revision!==expectedRevision||next.revision!==expectedRevision+1||previous.state!=='PENDING')fail('RBRIDGE_DELIVERY_CAS_INVALID');
        if(canonical(previous.identity)!==canonical(next.identity)||next.attempts<previous.attempts)fail();
        if(previous.publication){
          if(!next.publication)fail();for(const key of ['envelopeSha256','totalBytes','chunkCount'] as const)if(previous.publication[key]!==next.publication[key])fail();
          if(next.publication.nextIndex<previous.publication.nextIndex)fail();
          for(const key of ['manifestCommentId','receiptCommentId'] as const)if(previous.publication[key]!==undefined&&previous.publication[key]!==next.publication[key])fail();
        }
        if(next.state==='PUBLISHED'&&(!next.publication?.receiptCommentId||next.publication.nextIndex!==next.publication.chunkCount))fail();
        return commit(next,false);
      });
    },
    async pending(max){if(!Number.isSafeInteger(max)||max<1||max>limits.nonterminal)fail();return scan(max);},
  };
}
