import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {RBRIDGE_CORE_LIMITS as limits,type RBridgeCoreResultPage} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,assertRBridgeResultRange,canonicalRBridgeJson} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import type {RBridgeExecutionJournal,RBridgeOperationRecordV1} from './rbridgeExecutionJournal.js';
import {createRBridgeStateFiles,validateRBridgeStateHandle,type RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeExecutionResults{commit(id:string,value:RBridgeJsonValue):Promise<{sha256:string;bytes:number}>;page(record:RBridgeOperationRecordV1,cursor:number,maxBytes:number):Promise<RBridgeCoreResultPage>;}
function fail(code='RBRIDGE_CORE_RESULT_UNAVAILABLE'):never{throw new Error(code);}
const canonical=(value:unknown)=>canonicalRBridgeJson(value as RBridgeJsonValue);
export async function createRBridgeExecutionResults(options:{root:string;journal:RBridgeExecutionJournal;files?:RBridgeStateFiles}):Promise<RBridgeExecutionResults>{
  const {root,journal}=options,files=options.files??createRBridgeStateFiles(),uid=process.getuid?.();
  if(uid===undefined||uid<1||process.geteuid?.()!==uid)fail();await files.validateTree(root,uid);
  async function checked(operationId:string){
    const record=await journal.get(operationId);if(!record)fail();
    const expected={schema:'RBRIDGE_EXECUTION_JOURNAL_MANIFEST_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...record.policyDocument.binding};
    if(record.policyDocument.binding.runtimeUid!==uid||(await files.read(join(root,'manifest.json'),uid!,limits.recordBytes)).toString('utf8')!==canonical(expected))fail();return record;
  }
  const pathFor=(operationId:string)=>join(root,'results',`${operationId}.json`);
  return {
    async commit(operationId,value){
      const record=await checked(operationId);
      if(record.receipt.phase!=='RUNNING'||record.receipt.policy.decision!=='ALLOW')fail('RBRIDGE_CORE_RESULT_PHASE_INVALID');
      assertBoundedRBridgeJson(value,{bytes:limits.outputBytes,depth:limits.depth,nodes:limits.nodes});const data=Buffer.from(canonical(value)),sha256=createHash('sha256').update(data).digest('hex');
      journal.assertResultStageFits(operationId,data.length);let createOnly=true;
      try{const h=await files.file(pathFor(operationId),uid!,limits.outputBytes);await h.close();createOnly=false;}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
      try{
        await files.commit(pathFor(operationId),data,uid!,createOnly);await journal.accountResultCommit(operationId,data.length);
        const stored=await files.file(pathFor(operationId),uid!,limits.outputBytes);
        try{
          const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
          for(;;){const {bytesRead}=await stored.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>data.length)fail('RBRIDGE_CORE_RESULT_DIGEST_MISMATCH');hash.update(buffer.subarray(0,bytesRead));}
          const info=await stored.stat();validateRBridgeStateHandle(info,uid!,limits.outputBytes);
          if(total!==data.length||info.size!==total||hash.digest('hex')!==sha256)fail('RBRIDGE_CORE_RESULT_DIGEST_MISMATCH');
        }finally{await stored.close();}
      }
      catch(error){await journal.rescanAccounting().catch(()=>undefined);throw error;}
      return {sha256,bytes:data.length};
    },
    async page(input,cursor,maxBytes){
      assertRBridgeResultRange(cursor,maxBytes);const record=await checked(input.submission.operationId);
      if(record.intentSha256!==input.intentSha256||canonical(record.submission)!==canonical(input.submission))fail();
      if(record.receipt.phase!=='TERMINAL'||!record.receipt.resultSha256)return {status:'NOT_READY',receipt:record.receipt};
      const handle=await files.file(pathFor(record.submission.operationId),uid!,limits.outputBytes).catch(()=>fail());
      try{
        const hash=createHash('sha256'),buffer=Buffer.alloc(65536),page=Buffer.alloc(maxBytes);let total=0,pageBytes=0;
        for(;;){
          const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(bytesRead===0)break;
          if(total+bytesRead>limits.outputBytes)fail('RBRIDGE_CORE_RESULT_LIMIT');hash.update(buffer.subarray(0,bytesRead));
          const start=Math.max(cursor,total),end=Math.min(cursor+maxBytes,total+bytesRead);
          if(end>start){buffer.copy(page,start-cursor,start-total,end-total);pageBytes+=end-start;}total+=bytesRead;
        }
        const info=await handle.stat();validateRBridgeStateHandle(info,uid!,limits.outputBytes);
        if(info.size!==total||hash.digest('hex')!==record.receipt.resultSha256)fail('RBRIDGE_CORE_RESULT_DIGEST_MISMATCH');
        if(cursor>total)fail('RBRIDGE_CORE_RESULT_CURSOR_INVALID');
        return {status:'RESULT',receipt:record.receipt,resultSha256:record.receipt.resultSha256,cursor,nextCursor:cursor+pageBytes,eof:cursor+pageBytes===total,dataBase64:page.subarray(0,pageBytes).toString('base64')};
      }finally{await handle.close();}
    },
  };
}
