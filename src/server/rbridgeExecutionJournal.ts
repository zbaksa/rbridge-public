import {lstat,opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {RBRIDGE_CORE_LIMITS as limits,RBRIDGE_ENABLED_ACTIONS,type RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson,parseRBridgeDeploymentBinding,parseRBridgeExecutionReceipt} from '../domain/rbridgeCoreValidation.js';
import {canTransitionRBridgeExecutionPhase,parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeExecutionReceiptV1,type RBridgeJsonValue,type RBridgeOperationSubmissionV1,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {evaluateRBridgePolicyDocument,freezeRBridgeValue,type RBridgePolicyDecision,type RBridgePolicyDocumentV1} from './rbridgeExecutionPolicy.js';
import {createRBridgeStateFiles,rbridgeStateFdPath,validateRBridgeStateHandle,type RBridgeStateFiles} from './rbridgeStateFiles.js';
import type {RBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
export interface RBridgeOperationRecordV1{
  schema:'RBRIDGE_OPERATION_RECORD_V1';revision:number;submission:RBridgeOperationSubmissionV1;intentSha256:string;policyDocument:RBridgePolicyDocumentV1;receipt:RBridgeExecutionReceiptV1;
  observations:Partial<Record<RBridgeTransportContextV1['transport'],{first:RBridgeTransportContextV1;count:number}>>;
}
export interface RBridgeCapacity{identities:number;deliveries:number;nonterminal:number;journalBytes:number;resultBytes:number;canClaim():boolean;}
export interface RBridgeExecutionJournal{
  get(id:string):Promise<RBridgeOperationRecordV1|undefined>;has(id:string):Promise<boolean>;
  claim(input:{submission:RBridgeOperationSubmissionV1;decision:RBridgePolicyDecision;context:RBridgeTransportContextV1}):Promise<RBridgeOperationRecordV1>;
  update(id:string,expectedRevision:number,next:RBridgeOperationRecordV1):Promise<RBridgeOperationRecordV1>;
  recover():Promise<readonly RBridgeOperationRecordV1[]>;capacity():RBridgeCapacity;
  reserveDelivery(issueNumber:number):Promise<void>;accountDeliveryCommit(issueNumber:number,bytes:number):Promise<void>;
  assertResultStageFits(operationId:string,bytes:number):void;accountResultCommit(operationId:string,bytes:number):Promise<void>;
  rescanAccounting(releaseDelivery?:number):Promise<void>;
}
const ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
// A valid depth16 submission is nested once in this private record envelope.
// Transport/input/output validators retain their original depth16 bounds.
const bounds={bytes:limits.recordBytes,depth:limits.depth+1,nodes:8192};
function fail(code='RBRIDGE_JOURNAL_INVALID'):never{throw new Error(code);}
function missing(error:unknown){return (error as NodeJS.ErrnoException)?.code==='ENOENT';}
function json(value:unknown):string{return canonicalRBridgeJson(value as RBridgeJsonValue,bounds);}
function id(value:string):string{if(!ID.test(value))fail();return value;}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))fail();return value as Record<string,unknown>;}
export function parseRBridgePolicyDocument(value:unknown):RBridgePolicyDocumentV1{
  assertBoundedRBridgeJson(value,bounds);
  const row=exact(value,['schema','version','binding','enabledActions','allowedRoots','limits','recovery']);
  if(row.schema!=='RBRIDGE_POLICY_DOCUMENT_V1'||row.version!=='safe-core-p2a-v1')fail();
  parseRBridgeDeploymentBinding(row.binding);
  z.array(z.enum(RBRIDGE_ENABLED_ACTIONS)).max(7).refine(v=>new Set(v).size===v.length).parse(row.enabledActions);
  z.array(z.literal('/mnt/data')).max(1).parse(row.allowedRoots);
  const configured=exact(row.limits,Object.keys(limits));
  for(const [key,max] of Object.entries(limits)){const n=configured[key];if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>max)fail();}
  const recovery=exact(row.recovery,['incompleteReadonly','mutation']);if(recovery.incompleteReadonly!=='REOBSERVE'||recovery.mutation!=='NEVER_RETRY')fail();
  return freezeRBridgeValue(JSON.parse(JSON.stringify(value)) as RBridgePolicyDocumentV1);
}
const contextSchema=z.strictObject({schema:z.literal('RBRIDGE_TRANSPORT_CONTEXT_V1'),transport:z.enum(['GITHUB','MCP','LOCAL']),authenticatedSubject:z.string().min(1).refine(s=>Buffer.byteLength(s)<=512&&!s.includes('\0')),principalId:z.string().regex(ID),requestRef:z.string().refine(s=>Buffer.byteLength(s)<=512&&!s.includes('\0')).optional()});
export function parseRBridgeTransportContext(value:unknown):RBridgeTransportContextV1{assertBoundedRBridgeJson(value);return JSON.parse(JSON.stringify(contextSchema.parse(value))) as RBridgeTransportContextV1;}
function record(value:unknown,filenameId:string,binding:RBridgeDeploymentBinding):RBridgeOperationRecordV1{
  assertBoundedRBridgeJson(value,bounds);const row=exact(value,['schema','revision','submission','intentSha256','policyDocument','receipt','observations']);
  if(row.schema!=='RBRIDGE_OPERATION_RECORD_V1'||!Number.isSafeInteger(row.revision)||Number(row.revision)<1)fail();
  const submission=parseRBridgeOperationSubmissionV1(row.submission),intentSha256=rbridgeOperationIntentDigest(submission),policyDocument=parseRBridgePolicyDocument(row.policyDocument);
  if(submission.operationId!==filenameId||submission.principalId!==binding.principalId||submission.targetInstanceId!==binding.targetInstanceId||row.intentSha256!==intentSha256||json(policyDocument.binding)!==json(binding))fail();
  const receipt=parseRBridgeExecutionReceipt(row.receipt,submission,intentSha256);
  if(json(receipt.policy)!==json(evaluateRBridgePolicyDocument(policyDocument,submission).snapshot))fail('RBRIDGE_JOURNAL_POLICY_MISMATCH');
  if(receipt.policy.decision==='BLOCK'&&receipt.phase!=='CLAIMED'&&!(receipt.phase==='TERMINAL'&&receipt.outcome==='BLOCKED'&&receipt.transitions.length===2))fail();
  if(!row.observations||typeof row.observations!=='object'||Array.isArray(row.observations))fail();
  for(const [transport,observation] of Object.entries(row.observations)){
    if(!['MCP','GITHUB','LOCAL'].includes(transport))fail();const observed=exact(observation,['first','count']),first=parseRBridgeTransportContext(observed.first);
    if(first.transport!==transport||first.principalId!==binding.principalId||!Number.isSafeInteger(observed.count)||Number(observed.count)<1)fail();
  }
  return freezeRBridgeValue(JSON.parse(JSON.stringify({...row,submission,policyDocument,receipt})) as RBridgeOperationRecordV1);
}
export function canAdmitRBridgeOperation(state:{identities:number;nonterminal:number;entries:number;journalReservedBytes:number;resultReservedBytes:number}):boolean{
  return Object.values(state).every(n=>Number.isSafeInteger(n)&&n>=0)&&state.identities<limits.identities&&state.nonterminal<limits.nonterminal&&state.entries+3<=limits.stateEntryLimit&&state.journalReservedBytes+2*limits.recordBytes<=limits.journalBytes&&state.resultReservedBytes+2*limits.outputBytes<=limits.resultBytes;
}
interface Reservation{journal:number;results:number;resultCanonical:number;stageGeneration?:number;}
export async function createRBridgeExecutionJournal(options:{root:string;binding:RBridgeDeploymentBinding;serializer:RBridgeOperationSerializer;files?:RBridgeStateFiles}):Promise<RBridgeExecutionJournal>{
  const {root,serializer}=options,binding=parseRBridgeDeploymentBinding(options.binding),uid=binding.runtimeUid,files=options.files??createRBridgeStateFiles();
  if(process.getuid?.()!==uid||process.geteuid?.()!==uid)fail('RBRIDGE_JOURNAL_RUNTIME_IDENTITY_INVALID');
  await files.ensureDirectory(root,uid);await files.validateTree(root,uid);
  const directories=['operations','results','deliveries','deliveries/github'];
  for(const part of directories)await files.ensureDirectory(join(root,part),uid);
  const manifest={schema:'RBRIDGE_EXECUTION_JOURNAL_MANIFEST_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...binding},manifestPath=join(root,'manifest.json');
  try{const raw=await files.read(manifestPath,uid,limits.recordBytes);if(raw.toString('utf8')!==json(manifest))fail('RBRIDGE_JOURNAL_BINDING_MISMATCH');}
  catch(error){if(!missing(error))throw error;await files.commit(manifestPath,Buffer.from(json(manifest)),uid,true);}
  let identities=0,deliveries=0,journalBytes=0,resultBytes=0,entries=0,poisoned=false,accountingUnknown=false,generation=0;
  const reservations=new Map<string,Reservation>(),deliveryReservations=new Map<number,{bytes:number;fresh:boolean;generation:number}>();
  let globalTail=Promise.resolve();
  async function global<T>(task:()=>Promise<T>):Promise<T>{const previous=globalTail;let release!:()=>void;globalTail=new Promise<void>(done=>{release=done;});await previous;try{return await task();}finally{release();}}
  function healthy(){if(poisoned)fail('RBRIDGE_JOURNAL_DURABILITY_UNKNOWN');}
  function mutationHeld(operationId:string){healthy();if(accountingUnknown)fail('RBRIDGE_JOURNAL_ACCOUNTING_UNKNOWN');if(!serializer.isHeld(operationId))fail('RBRIDGE_CORE_SERIALIZER_REQUIRED');}
  const pathFor=(operationId:string)=>join(root,'operations',`${id(operationId)}.json`);
  async function get(operationId:string):Promise<RBridgeOperationRecordV1|undefined>{
    healthy();try{const raw=await files.read(pathFor(operationId),uid,limits.recordBytes),parsed=record(JSON.parse(raw.toString('utf8')),operationId,binding);if(raw.toString('utf8')!==json(parsed))fail();return parsed;}catch(error){if(missing(error))return undefined;throw error;}
  }
  async function scanDirectory(part:string,visit:(name:string,bytes:number)=>Promise<void>):Promise<void>{
    const handle=await files.directory(join(root,part),uid,true);
    try{
      const dir=await opendir(rbridgeStateFdPath(handle));
      try{for await(const entry of dir){if(++entries>limits.stateEntryLimit)fail('RBRIDGE_CORE_CAPACITY_REACHED');const h=await files.file(join(root,part,entry.name),uid,Number.MAX_SAFE_INTEGER);try{await visit(entry.name,(await h.stat()).size);}finally{await h.close();}}}
      finally{await dir.close().catch(error=>{if((error as NodeJS.ErrnoException).code!=='ERR_DIR_CLOSED')throw error;});}
    }finally{await handle.close();}
  }
  function operationName(name:string):string|undefined{const value=name.endsWith('.json')?name.slice(0,-5):undefined;return value&&ID.test(value)?value:undefined;}
  function stageId(name:string):string|undefined{const match=/^\.([a-z0-9][a-z0-9._:-]{0,127})\.json\.[0-9a-f-]{36}\.stage$/.exec(name);return match?.[1];}
  async function scan():Promise<readonly RBridgeOperationRecordV1[]>{
    accountingUnknown=true;generation++;const inFlightResults=new Map([...reservations].filter(([,v])=>v.stageGeneration!==undefined).map(([key,v])=>[key,v.stageGeneration!]));
    for(const item of deliveryReservations.values())item.fresh=true;
    identities=0;deliveries=0;journalBytes=(await files.read(manifestPath,uid,limits.recordBytes)).length;resultBytes=0;entries=0;reservations.clear();const incomplete:RBridgeOperationRecordV1[]=[];
    await scanDirectory('operations',async(name,bytes)=>{
      journalBytes+=bytes;const operationId=operationName(name);if(!operationId)return;
      if(++identities>limits.identities)fail('RBRIDGE_CORE_CAPACITY_REACHED');const current=await get(operationId);if(!current)fail();
      if(current.receipt.phase!=='TERMINAL'){if(incomplete.length>=limits.nonterminal)fail('RBRIDGE_CORE_CAPACITY_REACHED');incomplete.push(current);reservations.set(operationId,{journal:bytes,results:0,resultCanonical:0,...(inFlightResults.has(operationId)?{stageGeneration:inFlightResults.get(operationId)!}:{})});}
    });
    // Streaming second pass associates retained operation stages with only the bounded pending IDs.
    const operationDir=await files.directory(join(root,'operations'),uid,true);
    try{const dir=await opendir(rbridgeStateFdPath(operationDir));for await(const entry of dir){const pending=reservations.get(stageId(entry.name)??'');if(pending){const h=await files.file(join(root,'operations',entry.name),uid,Number.MAX_SAFE_INTEGER);try{pending.journal+=(await h.stat()).size;}finally{await h.close();}}}}finally{await operationDir.close();}
    await scanDirectory('results',async(name,bytes)=>{resultBytes+=bytes;const canonicalId=operationName(name),pending=reservations.get(canonicalId??stageId(name)??'');if(pending){pending.results+=bytes;if(canonicalId)pending.resultCanonical=bytes;}});
    await scanDirectory('deliveries/github',async(name,bytes)=>{journalBytes+=bytes;if(/^[1-9][0-9]*\.json$/.test(name)){if(++deliveries>limits.deliveries)fail('RBRIDGE_CORE_CAPACITY_REACHED');const reserved=deliveryReservations.get(Number(name.slice(0,-5)));if(reserved){reserved.bytes=bytes;reserved.fresh=false;}}});
    for(const reserved of deliveryReservations.values())if(reserved.fresh)deliveries++;
    // Unknown entries at the root/deliveries level also consume budget and entry capacity.
    for(const part of ['', 'deliveries']){
      const handle=await files.directory(join(root,part),uid,true);
      try{const dir=await opendir(rbridgeStateFdPath(handle));for await(const entry of dir){if(++entries>limits.stateEntryLimit)fail('RBRIDGE_CORE_CAPACITY_REACHED');if(part===''&&entry.name==='owner.lock'){const h=await files.file(join(root,entry.name),uid,limits.recordBytes);try{journalBytes+=(await h.stat()).size;}finally{await h.close();}continue;}if(part===''&&entry.name==='core.sock'){const info=await lstat(rbridgeStateFdPath(handle,entry.name));if(!info.isSocket()||info.uid!==uid||(info.mode&0o7777)!==0o600||info.nlink!==1)fail();continue;}if((part===''&&['manifest.json','operations','results','deliveries'].includes(entry.name))||(part==='deliveries'&&entry.name==='github'))continue;const h=await files.file(join(root,part,entry.name),uid,Number.MAX_SAFE_INTEGER);try{journalBytes+=(await h.stat()).size;}finally{await h.close();}}}finally{await handle.close();}
    }
    accountingUnknown=false;return incomplete;
  }
  function committedBudget(){let journal=journalBytes,results=resultBytes;for(const item of reservations.values()){journal+=Math.max(0,2*limits.recordBytes-item.journal);results+=Math.max(0,2*limits.outputBytes-item.results);}for(const item of deliveryReservations.values())journal+=Math.max(0,2*limits.recordBytes-item.bytes);return {journal,results};}
  function canClaim(){const budget=committedBudget();return !poisoned&&!accountingUnknown&&canAdmitRBridgeOperation({identities,nonterminal:reservations.size,entries,journalReservedBytes:budget.journal,resultReservedBytes:budget.results});}
  async function commitRecord(operationId:string,next:RBridgeOperationRecordV1,createOnly:boolean,oldBytes:number):Promise<RBridgeOperationRecordV1>{
    const data=Buffer.from(json(next));if(data.length>limits.recordBytes)fail('RBRIDGE_CORE_CAPACITY_REACHED');
    try{await files.commit(pathFor(operationId),data,uid,createOnly);}
    catch(error){await scan().catch(()=>undefined);poisoned=true;throw error;}
    journalBytes+=data.length-oldBytes;const pending=reservations.get(operationId);if(pending)pending.journal+=data.length-oldBytes;
    if(next.receipt.phase==='TERMINAL')reservations.delete(operationId);
    return next;
  }
  await scan();
  return {
    get,async has(operationId){return (await get(operationId))!==undefined;},
    capacity(){return {identities,deliveries,nonterminal:reservations.size,journalBytes,resultBytes,canClaim};},
    async recover(){return global(async()=>{healthy();return scan();});},
    async rescanAccounting(releaseDelivery){await global(async()=>{await scan();if(releaseDelivery!==undefined)deliveryReservations.delete(releaseDelivery);});},
    async claim(input){
      assertBoundedRBridgeJson(input.submission);const submission=parseRBridgeOperationSubmissionV1(input.submission),operationId=submission.operationId;mutationHeld(operationId);
      return global(async()=>{
        if(await get(operationId))fail('RBRIDGE_JOURNAL_ID_RESERVED');if(!canClaim())fail('RBRIDGE_CORE_CAPACITY_REACHED');
        const context=parseRBridgeTransportContext(input.context),policyDocument=parseRBridgePolicyDocument(input.decision.document);
        const intentSha256=rbridgeOperationIntentDigest(submission);
        const next=record({schema:'RBRIDGE_OPERATION_RECORD_V1',revision:1,submission,intentSha256,policyDocument,receipt:{schema:'RBRIDGE_EXECUTION_RECEIPT_V1',operationId,intentSha256,principalId:submission.principalId,targetInstanceId:submission.targetInstanceId,policy:input.decision.snapshot,phase:'CLAIMED',cancellation:{state:'NONE'},sideEffects:{state:'NONE_PROVEN'},transitions:[{phase:'CLAIMED',at:new Date().toISOString()}],postconditions:[]},observations:{[context.transport]:{first:context,count:1}}},operationId,binding);
        reservations.set(operationId,{journal:0,results:0,resultCanonical:0});identities++;entries++;
        return commitRecord(operationId,next,true,0);
      });
    },
    async update(operationId,expectedRevision,nextValue){
      mutationHeld(operationId);return global(async()=>{
        const previous=await get(operationId),next=record(nextValue,operationId,binding);
        if(!previous||previous.revision!==expectedRevision||next.revision!==expectedRevision+1||previous.receipt.phase==='TERMINAL')fail('RBRIDGE_JOURNAL_CAS_INVALID');
        for(const key of ['submission','intentSha256','policyDocument'] as const)if(json(previous[key])!==json(next[key]))fail();
        for(const key of ['schema','operationId','intentSha256','principalId','targetInstanceId','policy'] as const)if(json(previous.receipt[key])!==json(next.receipt[key]))fail();
        if(json(next.receipt.transitions.slice(0,previous.receipt.transitions.length))!==json(previous.receipt.transitions))fail();
        const phaseChanged=next.receipt.phase!==previous.receipt.phase;
        if(next.receipt.transitions.length!==previous.receipt.transitions.length+(phaseChanged?1:0)||(phaseChanged&&!canTransitionRBridgeExecutionPhase(previous.receipt.phase,next.receipt.phase)))fail();
        if(previous.receipt.cancellation.state==='REQUESTED'&&json(previous.receipt.cancellation)!==json(next.receipt.cancellation))fail();
        for(const [transport,old] of Object.entries(previous.observations)){const observation=next.observations[transport as RBridgeTransportContextV1['transport']];if(!observation||json(old.first)!==json(observation.first)||observation.count<old.count)fail();}
        return commitRecord(operationId,next,false,Buffer.byteLength(json(previous)));
      });
    },
    async reserveDelivery(issueNumber){
      if(!Number.isSafeInteger(issueNumber)||issueNumber<1)fail();await global(async()=>{
        healthy();if(accountingUnknown)fail('RBRIDGE_JOURNAL_ACCOUNTING_UNKNOWN');if(deliveryReservations.has(issueNumber))fail('RBRIDGE_DELIVERY_RESERVATION_EXISTS');
        let bytes=0,fresh=true;try{const h=await files.file(join(root,'deliveries/github',`${issueNumber}.json`),uid,limits.recordBytes);try{bytes=(await h.stat()).size;fresh=false;}finally{await h.close();}}catch(error){if(!missing(error))throw error;}
        const budget=committedBudget();if((fresh&&deliveries>=limits.deliveries)||budget.journal+2*limits.recordBytes-bytes>limits.journalBytes||entries+2>limits.stateEntryLimit)fail('RBRIDGE_CORE_CAPACITY_REACHED');
        deliveryReservations.set(issueNumber,{bytes,fresh,generation});if(fresh){deliveries++;entries++;}
      });
    },
    async accountDeliveryCommit(issueNumber,bytes){await global(async()=>{
      const reserved=deliveryReservations.get(issueNumber);if(!reserved||!Number.isSafeInteger(bytes)||bytes<0||bytes>limits.recordBytes)fail();
      const h=await files.file(join(root,'deliveries/github',`${issueNumber}.json`),uid,limits.recordBytes);try{if((await h.stat()).size!==bytes)fail();}finally{await h.close();}
      if(reserved.generation!==generation)await scan();else journalBytes+=bytes-reserved.bytes;
      deliveryReservations.delete(issueNumber);
    });},
    assertResultStageFits(operationId,bytes){mutationHeld(operationId);const pending=reservations.get(operationId);if(!pending||!Number.isSafeInteger(bytes)||bytes<0||bytes>limits.outputBytes||pending.results+bytes>2*limits.outputBytes||committedBudget().results>limits.resultBytes)fail('RBRIDGE_CORE_CAPACITY_REACHED');pending.stageGeneration=generation;},
    async accountResultCommit(operationId,bytes){mutationHeld(operationId);await global(async()=>{
      const pending=reservations.get(operationId);if(!pending||!Number.isSafeInteger(bytes)||bytes<0||bytes>limits.outputBytes)fail();
      const h=await files.file(join(root,'results',`${id(operationId)}.json`),uid,limits.outputBytes);try{validateRBridgeStateHandle(await h.stat(),uid,limits.outputBytes);if((await h.stat()).size!==bytes)fail();}finally{await h.close();}
      if(pending.stageGeneration!==generation){await scan();delete reservations.get(operationId)!.stageGeneration;return;}
      const difference=bytes-pending.resultCanonical;resultBytes+=difference;pending.results+=difference;if(pending.resultCanonical===0)entries++;pending.resultCanonical=bytes;delete pending.stageGeneration;
    });},
  };
}
