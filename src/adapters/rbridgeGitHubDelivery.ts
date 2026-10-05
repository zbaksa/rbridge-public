import {createHash} from 'node:crypto';
import type {GitHubBridgeIssue,RBridgeGitHubComment} from './githubIssueRemoteBridge.js';
import type {RBridgeGitHubCoreOptions} from './rbridgeGitHubCore.js';
import {RBRIDGE_CORE_LIMITS as limits} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,canonicalRBridgeJson,parseRBridgeCoreLookupResult,parseRBridgeCoreResultPage} from '../domain/rbridgeCoreValidation.js';
import type {RBridgeJsonValue,RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import type {RBridgeGitHubDeliveryRecordV1} from '../server/rbridgeDeliveryJournal.js';
import {createRBridgeOperationSerializer} from '../server/rbridgeOperationSerializer.js';
type Publication=NonNullable<RBridgeGitHubDeliveryRecordV1['publication']>;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),fence=(value:unknown)=>'```json\n'+JSON.stringify(value,null,2)+'\n```\n';
function fail(code:string):never{throw new Error(code);}
export function assertRBridgeGitHubIssue(issue:GitHubBridgeIssue,repository:string,authorLogin:string):void{
  if(!issue||!Number.isSafeInteger(issue.number)||issue.number<1||issue.authorLogin!==authorLogin||issue.url!=='https://github.com/'+repository+'/issues/'+issue.number||typeof issue.title!=='string'||Buffer.byteLength(issue.title)>1024||!issue.title.startsWith('[COCWIN BRIDGE REQUEST] ')||typeof issue.body!=='string'||Buffer.byteLength(issue.body)>limits.submissionBytes)fail('RBRIDGE_GITHUB_IDENTITY_CHANGED');
}
export function createRBridgeGitHubDelivery(options:RBridgeGitHubCoreOptions){
  const {binding,repository,authorLogin,core,deliveries,github}=options,serial=createRBridgeOperationSerializer();
  const context=(number:number):RBridgeTransportContextV1=>({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'GITHUB',authenticatedSubject:repository+':'+authorLogin,principalId:binding.principalId,requestRef:'issue:'+number});
  return {async reconcile(input:RBridgeGitHubDeliveryRecordV1):Promise<'WAITING'|'PUBLISHED'|'UNAVAILABLE'|'IDENTITY_BLOCKED'>{
    return serial.run(String(input.identity.issueNumber),async()=>{
      let record=await deliveries.get(input.identity.issueNumber);if(!record)fail('RBRIDGE_DELIVERY_RECORD_MISSING');if(record.state!=='PENDING')return record.state==='PUBLISHED'?'PUBLISHED':'IDENTITY_BLOCKED';
      const identity=record.identity,number=identity.issueNumber,ctx=context(number),scope={operationId:identity.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};
      async function update(patch:Partial<RBridgeGitHubDeliveryRecordV1>){record=await deliveries.update(number,record!.revision,{...record!,...patch,revision:record!.revision+1});}
      async function issue(){const current=await github.readIssue(number);assertRBridgeGitHubIssue(current,repository,authorLogin);if(identity.repository!==repository||identity.authorLogin!==authorLogin||current.number!==number||current.title!==identity.title||sha(current.body)!==identity.bodySha256||!['open','closed'].includes(current.state))fail('RBRIDGE_GITHUB_IDENTITY_CHANGED');return current;}
      try{
        await update({attempts:Math.min(Number.MAX_SAFE_INTEGER,record.attempts+1),lastReason:'RBRIDGE_DELIVERY_PENDING'});let current=await issue();
        const found=parseRBridgeCoreLookupResult(await core.status(identity.operationId,ctx),scope);if(found.status!=='RECEIPT'||found.receipt.intentSha256!==identity.intentSha256)fail('RBRIDGE_GITHUB_RECEIPT_INVALID');const receipt=found.receipt;if(receipt.phase!=='TERMINAL')return 'WAITING';
        let output:RBridgeJsonValue|undefined;
        if(receipt.resultSha256){
          const parts:Buffer[]=[];let cursor=0,eof=false;
          for(let n=0;n<=limits.outputBytes/limits.pageBytes&&!eof;n++){
            const page=parseRBridgeCoreResultPage(await core.result(identity.operationId,cursor,limits.pageBytes,ctx),scope,cursor,limits.pageBytes);
            if(page.status!=='RESULT'||canonicalRBridgeJson(page.receipt as unknown as RBridgeJsonValue)!==canonicalRBridgeJson(receipt as unknown as RBridgeJsonValue)||page.resultSha256!==receipt.resultSha256)fail('RBRIDGE_GITHUB_RESULT_INVALID');
            parts.push(Buffer.from(page.dataBase64,'base64'));cursor=page.nextCursor;eof=page.eof;
          }
          if(!eof||cursor>limits.outputBytes)fail('RBRIDGE_GITHUB_RESULT_INVALID');const bytes=Buffer.concat(parts,cursor);if(sha(bytes)!==receipt.resultSha256)fail('RBRIDGE_GITHUB_RESULT_INVALID');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);output=JSON.parse(text) as RBridgeJsonValue;assertBoundedRBridgeJson(output,{bytes:limits.outputBytes,depth:limits.depth,nodes:8192});if(canonicalRBridgeJson(output)!==text)fail('RBRIDGE_GITHUB_RESULT_INVALID');
        }
        const operationResult={schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt,...(output===undefined?{}:{output})},status=receipt.outcome==='TERMINATED'?'BLOCKED':receipt.outcome;
        const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:identity.operationId,issueNumber:number,status,requestSha256:identity.requestSha256,resultSha256:sha(JSON.stringify(operationResult)),operationResult,...(receipt.outcome==='TERMINATED'?{reason:'RBRIDGE_CORE_TERMINATED'}:receipt.reason?{reason:receipt.reason}:{}),completedAt:receipt.transitions.at(-1)!.at};
        const data=Buffer.from(JSON.stringify(envelope)),envelopeSha256=sha(data),direct=fence(envelope),count=Buffer.byteLength(direct)<60000?0:Math.ceil(data.length/40000),transferId='result-'+envelopeSha256;
        if(data.length>limits.outputBytes+limits.recordBytes||count>256)fail('RBRIDGE_GITHUB_RESULT_INVALID');
        const chunk=(index:number)=>{const bytes=data.subarray(index*40000,Math.min(data.length,(index+1)*40000));return fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:bytes.toString('base64'),chunkSha256:sha(bytes),objectSha256:envelopeSha256});};
        const manifest=fence({schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:data.length,objectSha256:envelopeSha256});
        if(record!.publication){const p=record!.publication;if(p.envelopeSha256!==envelopeSha256||p.totalBytes!==data.length||p.chunkCount!==count)fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');}
        else await update({publication:{envelopeSha256,totalBytes:data.length,chunkCount:count,nextIndex:0}});
        function checkedComment(comment:RBridgeGitHubComment,body:string){if(!Number.isSafeInteger(comment.id)||comment.id<1||comment.authorLogin!==authorLogin||comment.body!==body||comment.url!=='https://github.com/'+repository+'/issues/'+number+'#issuecomment-'+comment.id)fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');return comment;}
        async function history(){
          const chunks=new Set<number>(),receiptIds=new Set<number>(),manifestIds=new Set<number>();let total=0;
          for(let page=1;page<=52;page++){
            const rows=await github.readCommentPage(number,page);if(!Array.isArray(rows)||rows.length>20||total+rows.length>1024||Buffer.byteLength(JSON.stringify(rows))>2000000)fail('RBRIDGE_GITHUB_HISTORY_LIMIT');total+=rows.length;
            for(const comment of rows){
              if(comment.authorLogin!==authorLogin||!comment.body.startsWith('```json\n')||!comment.body.endsWith('\n```\n'))continue;
              if(Buffer.byteLength(comment.body)>=60000)fail('RBRIDGE_GITHUB_HISTORY_LIMIT');let row:unknown;try{row=JSON.parse(comment.body.slice(8,-5));}catch{continue;}assertBoundedRBridgeJson(row,{bytes:60000,depth:16,nodes:4096});if(!row||typeof row!=='object'||Array.isArray(row))continue;const value=row as Record<string,unknown>;
              if(count===0&&value.schema==='COCWIN_REMOTE_BRIDGE_RESULT_V2'&&value.requestId===identity.operationId){checkedComment(comment,direct);receiptIds.add(comment.id);}
              if(count>0&&value.transferId===transferId){
                if(value.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1'){if(!Number.isSafeInteger(value.index)||Number(value.index)<0||Number(value.index)>=count)fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');checkedComment(comment,chunk(Number(value.index)));chunks.add(Number(value.index));}
                else if(value.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'){checkedComment(comment,manifest);manifestIds.add(comment.id);receiptIds.add(comment.id);}
              }
            }
            if(rows.length<20)return {chunks,receiptIds,manifestIds};
          }
          fail('RBRIDGE_GITHUB_HISTORY_LIMIT');
        }
        let seen=await history();const prefix=()=>{let n=0;while(seen.chunks.has(n)&&n<count)n++;return n;};
        if(prefix()<record!.publication!.nextIndex)fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');
        let sent=0;
        for(let index=0;index<count&&sent<8;index++)if(!seen.chunks.has(index)){
          current=await issue();if(current.state!=='open')fail('RBRIDGE_GITHUB_CLOSED_WITHOUT_RECEIPT');const body=chunk(index);checkedComment(await github.postComment(number,body),body);seen.chunks.add(index);sent++;
          await update({publication:{...record!.publication!,nextIndex:prefix()}});
        }
        if(prefix()<count)return 'WAITING';
        if(seen.receiptIds.size===0){current=await issue();if(current.state!=='open')fail('RBRIDGE_GITHUB_CLOSED_WITHOUT_RECEIPT');const body=count>0?manifest:direct,comment=checkedComment(await github.postComment(number,body),body);seen.receiptIds.add(comment.id);if(count>0)seen.manifestIds.add(comment.id);}
        function id(existing:number|undefined,ids:Set<number>){if(existing!==undefined){if(!ids.has(existing))fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');return existing;}if(ids.size===0)fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');return Math.min(...ids);}
        const publication:Publication={...record!.publication!,nextIndex:count,receiptCommentId:id(record!.publication!.receiptCommentId,seen.receiptIds),...(count>0?{manifestCommentId:id(record!.publication!.manifestCommentId,seen.manifestIds)}:{})};
        await update({publication});
        // Verify fresh carrier bytes before closure and after any lost close ack.
        seen=await history();if(prefix()!==count||!seen.receiptIds.has(publication.receiptCommentId!))fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');if(count>0&&!seen.manifestIds.has(publication.manifestCommentId!))fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');
        current=await issue();if(current.state==='open')await github.closeIssue(number);current=await issue();if(current.state!=='closed')fail('RBRIDGE_GITHUB_CLOSE_UNCONFIRMED');
        seen=await history();if(prefix()!==count||!seen.receiptIds.has(publication.receiptCommentId!)||(count>0&&!seen.manifestIds.has(publication.manifestCommentId!)))fail('RBRIDGE_GITHUB_PUBLICATION_COLLISION');
        await update({state:'PUBLISHED',lastReason:'RBRIDGE_DELIVERY_PUBLISHED'});return 'PUBLISHED';
      }catch(error){
        const changed=error instanceof Error&&error.message==='RBRIDGE_GITHUB_IDENTITY_CHANGED';
        try{await update({...(changed?{state:'IDENTITY_BLOCKED' as const}:{}),lastReason:changed?'RBRIDGE_DELIVERY_IDENTITY_CHANGED':'RBRIDGE_DELIVERY_PUBLICATION_PENDING'});}catch{/* Execution truth is independent of failed delivery persistence. */}
        return changed?'IDENTITY_BLOCKED':'UNAVAILABLE';
      }
    });
  }};
}
