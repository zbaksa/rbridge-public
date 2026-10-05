import {assertRBridgeGitHubIssue} from '../adapters/rbridgeGitHubDelivery.js';
import {assertBoundedRBridgeJson} from '../domain/rbridgeCoreValidation.js';
import type {createRBridgeGitHubCore} from '../adapters/rbridgeGitHubCore.js';
import {createHash} from 'node:crypto';
import {parseRemoteBridgeRequest,remoteBridgeRequestDigest,type RemoteBridgeRequest} from '../domain/remoteBridgeProtocol.js';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest,type RemoteBridgeRequestV2} from '../domain/remoteBridgeStage2Protocol.js';
import type {GitHubBridgeIssue} from '../adapters/githubIssueRemoteBridge.js';
import type {createRemoteBridgeStore} from './remoteBridgeStore.js';

type Store=ReturnType<typeof createRemoteBridgeStore>;
interface GitHubPort {listOpenRequests():Promise<GitHubBridgeIssue[]>;publishResult(issue:number,result:unknown):Promise<void>;}
interface ControllerPort {submit(app:string,job:string,payload:unknown):Promise<Record<string,unknown>>;status(app:string,job:string):Promise<Record<string,unknown>>;result(app:string,job:string):Promise<Record<string,unknown>>;}
interface FilePort {execute(operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'FILE'}>):Promise<unknown>;}
interface ChunkPort {putChunk(input:{transferId:string;index:number;count:number;dataBase64:string;chunkSha256:string;objectSha256:string;expiresAt:string}):Promise<unknown>;getChunk(transferId:string,index:number):Promise<unknown>;finalizeTransfer(transferId:string):Promise<unknown>;}
interface HealthPort {snapshot():unknown|Promise<unknown>;}
interface ProcessPort {execute(operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'PROCESS'}>,requestDigest:string):Promise<unknown>;}
export interface RemoteBridgeWorkerOptions {store:Store;github:GitHubPort;githubCore?:ReturnType<typeof createRBridgeGitHubCore>;reservations?:{isReserved(id:string):Promise<boolean>};controller:ControllerPort;fileOps?:FilePort;chunkStore?:ChunkPort;health?:HealthPort;processSessions?:ProcessPort;now?:()=>Date;maxIssues?:number;repository:string;authorLogin:string;instanceId:string;}
export interface RemoteBridgeRunSummary {seen:number;pending:number;published:number;blocked:number;errors:number;}
interface BridgeResultV1 {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1';requestId:string;issueNumber:number;status:'PASS'|'FAIL'|'BLOCKED'|'UNCERTAIN';requestSha256:string;resultSha256?:string;controllerResult?:Record<string,unknown>;reason?:string;completedAt:string;}
interface BridgeResultV2 {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2';requestId:string;issueNumber:number;status:'PASS'|'FAIL'|'BLOCKED'|'UNCERTAIN';requestSha256:string;resultSha256?:string;operationResult?:unknown;reason?:string;completedAt:string;}
const PREFIX='[COCWIN BRIDGE REQUEST] ',SAFE_ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const REMOTE_BRIDGE_STAGE2_FILE_NOT_CONFIGURED='REMOTE_BRIDGE_STAGE2_FILE_NOT_CONFIGURED';
const READ_ONLY_FILE_ACTIONS=new Set(['LIST','STAT','READ','READ_MANY','READ_BINARY','SEARCH']);
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function errorCode(error:unknown){return error instanceof Error&&error.message?error.message.split('\n')[0]!.slice(0,512):'REMOTE_BRIDGE_UNKNOWN_ERROR';}
function requestId(issue:GitHubBridgeIssue){const value=issue.title.startsWith(PREFIX)?issue.title.slice(PREFIX.length):'';return SAFE_ID.test(value)?value:`issue-${issue.number}`;}
function terminalStatus(value:Record<string,unknown>):BridgeResultV1['status']{if(value.timed_out===true||value.truncated===true||value.state==='UNCERTAIN')return 'UNCERTAIN';if(value.state==='SUCCEEDED')return 'PASS';if(value.state==='FAILED')return 'FAIL';if(value.state==='BLOCKED')return 'BLOCKED';return 'UNCERTAIN';}
function appExecutionPending(value:Record<string,unknown>):boolean{return value.state==='QUEUED'||value.state==='RUNNING'||value.state==='UNCERTAIN';}
function bodySchema(body:string){try{const value=JSON.parse(body) as unknown;return value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).schema==='string'?String((value as Record<string,unknown>).schema):undefined;}catch{return undefined;}}
function blockedV1(issue:GitHubBridgeIssue,digest:string,reason:string,now:Date):BridgeResultV1{return {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:requestId(issue),issueNumber:issue.number,status:'BLOCKED',requestSha256:digest,reason,completedAt:now.toISOString()};}
function completedV1(request:RemoteBridgeRequest,issue:number,digest:string,value:Record<string,unknown>,now:Date):BridgeResultV1{const status=terminalStatus(value),reason=status==='BLOCKED'&&typeof value.reason==='string'?value.reason.replace(/\s+/g,' ').trim().slice(0,512):undefined;return {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:request.requestId,issueNumber:issue,status,requestSha256:digest,resultSha256:sha(JSON.stringify(value)),controllerResult:value,...(reason?{reason}:{}),completedAt:now.toISOString()};}
function blockedV2(issue:GitHubBridgeIssue,requestIdValue:string,digest:string,reason:string,now:Date):BridgeResultV2{return {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:requestIdValue||requestId(issue),issueNumber:issue.number,status:'BLOCKED',requestSha256:digest,reason,completedAt:now.toISOString()};}
function uncertainV2(issue:GitHubBridgeIssue,requestIdValue:string,digest:string,reason:string,now:Date):BridgeResultV2{return {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:requestIdValue||requestId(issue),issueNumber:issue.number,status:'UNCERTAIN',requestSha256:digest,reason,completedAt:now.toISOString()};}
function processErrorMayHaveExecuted(code:string):boolean{return code==='REMOTE_BRIDGE_PROCESS_START_UNCERTAIN'||code==='REMOTE_BRIDGE_PROCESS_INPUT_WRITE_UNCERTAIN'||code==='REMOTE_BRIDGE_PROCESS_ACTION_UNCERTAIN'||code==='REMOTE_BRIDGE_PROCESS_TERMINATE_UNCERTAIN'||code==='REMOTE_BRIDGE_PROCESS_SUPERVISOR_UNREACHABLE'||code==='REMOTE_BRIDGE_PROCESS_SUPERVISOR_TIMEOUT';}
function completedV2(request:RemoteBridgeRequestV2,issue:number,digest:string,value:unknown,now:Date):BridgeResultV2{const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined,appState=row&&['SUCCEEDED','FAILED','BLOCKED','UNCERTAIN'].includes(String(row.state)),status=appState?terminalStatus(row!):'PASS',reason=status==='BLOCKED'&&row&&typeof row.reason==='string'?row.reason.replace(/\s+/g,' ').trim().slice(0,512):undefined;return {schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId:request.requestId,issueNumber:issue,status,requestSha256:digest,resultSha256:sha(JSON.stringify(value)),operationResult:value,...(reason?{reason}:{}),completedAt:now.toISOString()};}

// Normalize only errors from the read-only file operation, never from result persistence.
async function executeFileOperation(port:FilePort,operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'FILE'}>):Promise<unknown>{
  try{return await port.execute(operation);}
  catch(error){
    const missing=error!==null&&typeof error==='object'&&'code' in error&&error.code==='ENOENT';
    if(missing&&['LIST','STAT','READ','READ_MANY','SEARCH'].includes(operation.action))throw new Error('REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND');
    throw error;
  }
}

export function createRemoteBridgeWorker(options:RemoteBridgeWorkerOptions){
  const now=options.now??(()=>new Date()),max=options.maxIssues??20,repository=options.repository,authorLogin=options.authorLogin,instanceId=options.instanceId;
  if(!Number.isInteger(max)||max<1||max>1000)throw new Error('REMOTE_BRIDGE_MAX_ISSUES_INVALID');
  if(typeof instanceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instanceId))throw new Error('REMOTE_BRIDGE_INSTANCE_ID_INVALID');
  if(Boolean(options.githubCore)!==Boolean(options.reservations))throw new Error('RBRIDGE_OWNER_ROUTING_CONFIG_INVALID');
  const scopeSha256=sha(JSON.stringify({repository,authorLogin,instanceId}));let issueCursor=0;
  async function publishStored(requestIdValue:string,digest:string,issue:GitHubBridgeIssue,result:BridgeResultV1|BridgeResultV2,summary:RemoteBridgeRunSummary){await options.store.markTerminal(requestIdValue,digest,result);try{await options.github.publishResult(issue.number,result);await options.store.markPublished(requestIdValue,digest);summary.published++;if(result.status==='BLOCKED')summary.blocked++;}catch{summary.errors++;}}
  async function publishReplay(recordResult:unknown,issue:GitHubBridgeIssue,requestIdValue:string,digest:string,phase:string,summary:RemoteBridgeRunSummary){if(!recordResult||typeof recordResult!=='object'||Array.isArray(recordResult)){summary.errors++;return;}const result:Record<string,unknown>={...(recordResult as Record<string,unknown>),issueNumber:issue.number,reason:'REPLAY'};try{await options.github.publishResult(issue.number,result);if(phase==='TERMINAL')await options.store.markPublished(requestIdValue,digest);summary.published++;if(result.status==='BLOCKED')summary.blocked++;}catch{summary.errors++;}}
  async function reconcileV1(request:RemoteBridgeRequest,issue:GitHubBridgeIssue,digest:string,summary:RemoteBridgeRunSummary){let status:Record<string,unknown>;try{status=await options.controller.status(request.appId,request.jobId);}catch{summary.pending++;summary.errors++;return;}if(appExecutionPending(status)){summary.pending++;return;}if(status.state==='BLOCKED'){await publishStored(request.requestId,digest,issue,completedV1(request,issue.number,digest,status,now()),summary);return;}try{await publishStored(request.requestId,digest,issue,completedV1(request,issue.number,digest,await options.controller.result(request.appId,request.jobId),now()),summary);}catch{summary.pending++;summary.errors++;}}
  async function reconcileV2App(request:RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'APP_RUN'}>},issue:GitHubBridgeIssue,digest:string,summary:RemoteBridgeRunSummary){const operation=request.operation;let status:Record<string,unknown>;try{status=await options.controller.status(operation.appId,operation.jobId);}catch{summary.pending++;summary.errors++;return;}if(appExecutionPending(status)){summary.pending++;return;}if(status.state==='BLOCKED'){await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,status,now()),summary);return;}try{await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,await options.controller.result(operation.appId,operation.jobId),now()),summary);}catch{summary.pending++;summary.errors++;}}
  async function executeChunk(request:RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'CHUNK'}>}){if(!options.chunkStore)throw new Error('REMOTE_BRIDGE_STAGE2_CHUNK_NOT_CONFIGURED');const operation=request.operation,args=operation.args;if(operation.action==='PUT')return await options.chunkStore.putChunk({transferId:operation.transferId,index:args.index as number,count:args.count as number,dataBase64:args.dataBase64 as string,chunkSha256:args.chunkSha256 as string,objectSha256:args.objectSha256 as string,expiresAt:args.expiresAt as string});if(operation.action==='GET')return await options.chunkStore.getChunk(operation.transferId,args.index as number);return await options.chunkStore.finalizeTransfer(operation.transferId);}
  async function executeV2File(request:RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'FILE'}>},issue:GitHubBridgeIssue,digest:string,summary:RemoteBridgeRunSummary){try{if(!options.fileOps)throw new Error(REMOTE_BRIDGE_STAGE2_FILE_NOT_CONFIGURED);const value=await executeFileOperation(options.fileOps,request.operation);await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,value,now()),summary);}catch(error){const code=errorCode(error);if(code===REMOTE_BRIDGE_STAGE2_FILE_NOT_CONFIGURED||code.startsWith('REMOTE_BRIDGE_FILE_'))await publishStored(request.requestId,digest,issue,blockedV2(issue,request.requestId,digest,code,now()),summary);else{summary.pending++;summary.errors++;}}}
  async function executeV2Dispatch(request:RemoteBridgeRequestV2,issue:GitHubBridgeIssue,digest:string,summary:RemoteBridgeRunSummary){if(request.operation.kind==='FILE')return await executeV2File(request as RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'FILE'}>},issue,digest,summary);return await executeV2Host(request,issue,digest,summary);}
  async function executeV2Host(request:RemoteBridgeRequestV2,issue:GitHubBridgeIssue,digest:string,summary:RemoteBridgeRunSummary){
    try{
      let value:unknown;
      if(request.operation.kind==='PROCESS'){if(!options.processSessions)throw new Error('REMOTE_BRIDGE_STAGE2_PROCESS_NOT_CONFIGURED');value=await options.processSessions.execute(request.operation,digest);}
      else if(request.operation.kind==='CHUNK')value=await executeChunk(request as RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'CHUNK'}>});
      else if(request.operation.kind==='HEALTH'){if(!options.health)throw new Error('REMOTE_BRIDGE_STAGE2_HEALTH_NOT_CONFIGURED');value=await options.health.snapshot();}
      else{await publishStored(request.requestId,digest,issue,blockedV2(issue,request.requestId,digest,'REMOTE_BRIDGE_STAGE2_OPERATION_NOT_CONFIGURED',now()),summary);return;}
      await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,value,now()),summary);
    }catch(error){const code=errorCode(error);if(request.operation.kind==='PROCESS'&&processErrorMayHaveExecuted(code))await publishStored(request.requestId,digest,issue,uncertainV2(issue,request.requestId,digest,code,now()),summary);else if(code==='REMOTE_BRIDGE_STAGE2_CHUNK_NOT_CONFIGURED'||code==='REMOTE_BRIDGE_STAGE2_HEALTH_NOT_CONFIGURED'||code==='REMOTE_BRIDGE_STAGE2_PROCESS_NOT_CONFIGURED'||code.startsWith('REMOTE_BRIDGE_CHUNK_')||code.startsWith('REMOTE_BRIDGE_HEALTH_')||code.startsWith('REMOTE_BRIDGE_PROCESS_'))await publishStored(request.requestId,digest,issue,blockedV2(issue,request.requestId,digest,code,now()),summary);else{summary.pending++;summary.errors++;}}
  }
  async function handleV1(issue:GitHubBridgeIssue,summary:RemoteBridgeRunSummary){
    let request:RemoteBridgeRequest,digest:string;
    try{
      request=parseRemoteBridgeRequest({title:issue.title,body:issue.body,authorLogin:issue.authorLogin,expectedAuthorLogin:authorLogin,now:now()});
      digest=remoteBridgeRequestDigest(request);
    }catch(error){
      const code=errorCode(error);
      if(code==='REMOTE_BRIDGE_REQUEST_EXPIRED'){
        try{
          request=parseRemoteBridgeRequest({title:issue.title,body:issue.body,authorLogin:issue.authorLogin,expectedAuthorLogin:authorLogin,now:now(),allowExpired:true});
          digest=remoteBridgeRequestDigest(request);
          const existing=await options.store.get(request.requestId);
          if(!existing||existing.requestSha256!==digest){
            const result=blockedV1(issue,sha(issue.body),code,now());
            try{await options.github.publishResult(issue.number,result);summary.published++;summary.blocked++;}catch{summary.errors++;}
            return;
          }
        }catch{summary.errors++;return;}
      }else{
        const result=blockedV1(issue,sha(issue.body),code,now());
        try{await options.github.publishResult(issue.number,result);summary.published++;summary.blocked++;}catch{summary.errors++;}
        return;
      }
    }
    const claim=await options.store.claim({requestId:request.requestId,requestSha256:digest,scopeSha256,issueNumber:issue.number,jobId:request.jobId});
    if(claim.state==='SCOPE_MISMATCH'){
      try{await options.github.publishResult(issue.number,blockedV1(issue,digest,'REQUEST_SCOPE_MISMATCH',now()));summary.published++;summary.blocked++;}catch{summary.errors++;}
      return;
    }
    if(claim.state==='COLLISION'){
      try{await options.github.publishResult(issue.number,blockedV1(issue,digest,'REQUEST_ID_COLLISION',now()));summary.published++;summary.blocked++;}catch{summary.errors++;}
      return;
    }
    if(claim.state==='REPLAY'&&(claim.record.phase==='TERMINAL'||claim.record.phase==='PUBLISHED')&&claim.record.result){
      await publishReplay(claim.record.result,issue,request.requestId,digest,claim.record.phase,summary);return;
    }
    if(claim.state==='REPLAY'&&claim.record.phase==='SUBMITTED'){await reconcileV1(request,issue,digest,summary);return;}
    if(claim.state==='REPLAY'&&claim.record.phase!=='CLAIMED'){summary.errors++;return;}
    await options.store.markSubmitted(request.requestId,digest);
    let status:Record<string,unknown>;
    try{status=await options.controller.submit(request.appId,request.jobId,request.payload);}catch{summary.pending++;summary.errors++;return;}
    if(appExecutionPending(status)){summary.pending++;return;}
    if(status.state==='BLOCKED'){await publishStored(request.requestId,digest,issue,completedV1(request,issue.number,digest,status,now()),summary);return;}
    try{await publishStored(request.requestId,digest,issue,completedV1(request,issue.number,digest,await options.controller.result(request.appId,request.jobId),now()),summary);}catch{summary.pending++;summary.errors++;}
  }

  async function handleV2(issue:GitHubBridgeIssue,summary:RemoteBridgeRunSummary){
    let request:RemoteBridgeRequestV2,digest:string;
    try{
      request=parseRemoteBridgeRequestV2({title:issue.title,body:issue.body,author:issue.authorLogin,repository,expectedAuthor:authorLogin,expectedRepository:repository,now:now()});
      digest=remoteBridgeRequestV2Digest(request);
    }catch(error){
      const code=errorCode(error);
      if(code==='REMOTE_BRIDGE_V2_REQUEST_EXPIRED'){
        try{
          request=parseRemoteBridgeRequestV2({title:issue.title,body:issue.body,author:issue.authorLogin,repository,expectedAuthor:authorLogin,expectedRepository:repository,now:now(),allowExpired:true});
          digest=remoteBridgeRequestV2Digest(request);
          const existing=await options.store.get(request.requestId);
          if(!existing||existing.requestSha256!==digest){
            const result=blockedV2(issue,requestId(issue),sha(issue.body),code,now());
            try{await options.github.publishResult(issue.number,result);summary.published++;summary.blocked++;}catch{summary.errors++;}
            return;
          }
        }catch{summary.errors++;return;}
      }else{
        const result=blockedV2(issue,requestId(issue),sha(issue.body),code,now());
        try{await options.github.publishResult(issue.number,result);summary.published++;summary.blocked++;}catch{summary.errors++;}
        return;
      }
    }
    const operation=request.operation,jobId=operation.kind==='APP_RUN'?operation.jobId:`host-${digest.slice(0,48)}`;
    const claim=await options.store.claim({requestId:request.requestId,requestSha256:digest,scopeSha256,issueNumber:issue.number,jobId});
    if(claim.state==='SCOPE_MISMATCH'){
      try{await options.github.publishResult(issue.number,blockedV2(issue,request.requestId,digest,'REQUEST_SCOPE_MISMATCH',now()));summary.published++;summary.blocked++;}catch{summary.errors++;}
      return;
    }
    if(claim.state==='COLLISION'){
      try{await options.github.publishResult(issue.number,blockedV2(issue,request.requestId,digest,'REQUEST_ID_COLLISION',now()));summary.published++;summary.blocked++;}catch{summary.errors++;}
      return;
    }
    if(claim.state==='REPLAY'&&(claim.record.phase==='TERMINAL'||claim.record.phase==='PUBLISHED')&&claim.record.result){
      await publishReplay(claim.record.result,issue,request.requestId,digest,claim.record.phase,summary);return;
    }
    if(claim.state==='REPLAY'&&claim.record.phase==='SUBMITTED'){
      if(operation.kind==='APP_RUN'){await reconcileV2App(request as RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'APP_RUN'}>},issue,digest,summary);return;}
      if(operation.kind==='FILE'){
        if(READ_ONLY_FILE_ACTIONS.has(operation.action))await executeV2File(request as RemoteBridgeRequestV2&{operation:Extract<RemoteBridgeRequestV2['operation'],{kind:'FILE'}>},issue,digest,summary);
        else await publishStored(request.requestId,digest,issue,uncertainV2(issue,request.requestId,digest,'REMOTE_BRIDGE_FILE_EFFECT_UNCERTAIN',now()),summary);
        return;
      }
      if(operation.kind==='CHUNK'||operation.kind==='HEALTH'||operation.kind==='PROCESS'){await executeV2Dispatch(request,issue,digest,summary);return;}
      summary.errors++;return;
    }
    if(claim.state==='REPLAY'&&claim.record.phase!=='CLAIMED'){summary.errors++;return;}
    await options.store.markSubmitted(request.requestId,digest);
    if(operation.kind==='APP_RUN'){
      let status:Record<string,unknown>;
      try{status=await options.controller.submit(operation.appId,operation.jobId,operation.payload);}catch{summary.pending++;summary.errors++;return;}
      if(appExecutionPending(status)){summary.pending++;return;}
      if(status.state==='BLOCKED'){await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,status,now()),summary);return;}
      try{await publishStored(request.requestId,digest,issue,completedV2(request,issue.number,digest,await options.controller.result(operation.appId,operation.jobId),now()),summary);}catch{summary.pending++;summary.errors++;}
      return;
    }
    await executeV2Dispatch(request,issue,digest,summary);
  }

  return {async runOnce():Promise<RemoteBridgeRunSummary>{
    const summary:RemoteBridgeRunSummary={seen:0,pending:0,published:0,blocked:0,errors:0};
    // Closed carriers remain delivery work even if polling open issues fails.
    await options.githubCore?.reconcileDeliveries(20);
    const issues=await options.github.listOpenRequests();
    const selected:GitHubBridgeIssue[]=[];
    if(issues.length<=max){selected.push(...issues);issueCursor=0;}
    else{
      for(let offset=0;offset<max;offset++)selected.push(issues[(issueCursor+offset)%issues.length]!);
      issueCursor=(issueCursor+max)%issues.length;
    }
    for(const issue of selected){
      summary.seen++;
      let v2=false;
      if(options.githubCore){
        try{
          assertRBridgeGitHubIssue(issue,repository,authorLogin);
          const raw:unknown=JSON.parse(issue.body);assertBoundedRBridgeJson(raw);v2=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).schema==='COCWIN_REMOTE_BRIDGE_REQUEST_V2';
          if(v2){
            const request=parseRemoteBridgeRequestV2({title:issue.title,body:issue.body,author:issue.authorLogin,repository,expectedAuthor:authorLogin,expectedRepository:repository,now:now(),allowExpired:true});
            if(request.operation.kind!=='APP_RUN'){
              // A FlowPilot-only reservation cannot become a new legacy relay claim.
              const reserved=await options.reservations!.isReserved(request.requestId);
              const existing=reserved?await options.store.get(request.requestId):undefined;
              if(!existing){const state=await options.githubCore.admit(issue);summary.pending++;if(state==='PUBLICATION_UNAVAILABLE')summary.errors++;continue;}
            }
          }
        }catch{summary.errors++;continue;}
      }else v2=bodySchema(issue.body)==='COCWIN_REMOTE_BRIDGE_REQUEST_V2';
      try{if(v2)await handleV2(issue,summary);else await handleV1(issue,summary);}
      catch(error){
        if(options.githubCore&&errorCode(error)==='RBRIDGE_CORE_LEGACY_ID_RESERVED'){
          const digest=v2?remoteBridgeRequestV2Digest(parseRemoteBridgeRequestV2({title:issue.title,body:issue.body,author:issue.authorLogin,repository,expectedAuthor:authorLogin,expectedRepository:repository,now:now(),allowExpired:true})):remoteBridgeRequestDigest(parseRemoteBridgeRequest({title:issue.title,body:issue.body,authorLogin:issue.authorLogin,expectedAuthorLogin:authorLogin,now:now(),allowExpired:true}));
          const result=v2?blockedV2(issue,requestId(issue),digest,'RBRIDGE_CORE_LEGACY_ID_RESERVED',now()):blockedV1(issue,digest,'RBRIDGE_CORE_LEGACY_ID_RESERVED',now());
          try{await options.github.publishResult(issue.number,result);summary.published++;summary.blocked++;}catch{summary.errors++;}
        }else throw error;
      }
    }
    return summary;
  }};
}