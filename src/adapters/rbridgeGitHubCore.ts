import {createHash} from 'node:crypto';
import type {GitHubBridgeIssue,RBridgeGitHubPort} from './githubIssueRemoteBridge.js';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest} from '../domain/remoteBridgeStage2Protocol.js';
import type {RBridgeCorePort,RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import {assertBoundedRBridgeJson,parseRBridgeCoreLookupResult,parseRBridgeCoreSubmitResult,parseRBridgeDeploymentBinding} from '../domain/rbridgeCoreValidation.js';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import type {RBridgeDeliveryJournal} from '../server/rbridgeDeliveryJournal.js';
import {createRBridgeOperationSerializer} from '../server/rbridgeOperationSerializer.js';
import {assertRBridgeGitHubIssue,createRBridgeGitHubDelivery} from './rbridgeGitHubDelivery.js';
export interface RBridgeGitHubCoreOptions {repository:string;authorLogin:string;binding:RBridgeDeploymentBinding;core:RBridgeCorePort;deliveries:RBridgeDeliveryJournal;github:RBridgeGitHubPort;now?:()=>Date;}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function createRBridgeGitHubCore(options:RBridgeGitHubCoreOptions){
  const binding=parseRBridgeDeploymentBinding(options.binding),{repository,authorLogin,core,deliveries,github}=options,now=options.now??(()=>new Date()),serial=createRBridgeOperationSerializer();
  if(!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(authorLogin))throw new Error('RBRIDGE_GITHUB_CONFIG_INVALID');
  const publisher=createRBridgeGitHubDelivery({...options,binding});
  function context(number:number):RBridgeTransportContextV1{return {schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'GITHUB',authenticatedSubject:repository+':'+authorLogin,principalId:binding.principalId,requestRef:'issue:'+number};}
  return {
    async admit(issue:GitHubBridgeIssue):Promise<'CORE'|'PUBLICATION_UNAVAILABLE'>{
      try{
        assertRBridgeGitHubIssue(issue,repository,authorLogin);
        return await serial.run(String(issue.number),async()=>{
          const current=await github.readIssue(issue.number);assertRBridgeGitHubIssue(current,repository,authorLogin);
          if(current.number!==issue.number||current.title!==issue.title||current.body!==issue.body)throw new Error('RBRIDGE_GITHUB_IDENTITY_CHANGED');
          const input={title:issue.title,body:issue.body,author:authorLogin,repository,expectedAuthor:authorLogin,expectedRepository:repository,now:now()};
          // Bound the original JSON before either recursive semantic digest.
          const json:unknown=JSON.parse(issue.body);assertBoundedRBridgeJson(json);
          const request=parseRemoteBridgeRequestV2({...input,allowExpired:true});
          const submission=parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:request.requestId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation:request.operation});assertBoundedRBridgeJson(submission);
          const identity={repository,issueNumber:issue.number,authorLogin,title:issue.title,bodySha256:sha(issue.body),requestSha256:remoteBridgeRequestV2Digest(request),operationId:submission.operationId,intentSha256:rbridgeOperationIntentDigest(submission)};
          const old=await deliveries.get(issue.number);
          if(old){
            if(Object.entries(identity).some(([key,value])=>old.identity[key as keyof typeof identity]!==value)){
              if(old.state==='PENDING')await publisher.reconcile(old);
              return 'PUBLICATION_UNAVAILABLE';
            }
            const state=await publisher.reconcile(old);return state==='UNAVAILABLE'||state==='IDENTITY_BLOCKED'?'PUBLICATION_UNAVAILABLE':'CORE';
          }
          const ctx=context(issue.number),scope={operationId:submission.operationId,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};
          const known=parseRBridgeCoreLookupResult(await core.status(submission.operationId,ctx),scope);
          if(known.status==='NOT_FOUND'){if(current.state!=='open')throw new Error('RBRIDGE_GITHUB_CLOSED_NEW_REQUEST');parseRemoteBridgeRequestV2(input);}
          const admitted=parseRBridgeCoreSubmitResult(await core.submit(submission,ctx,new AbortController().signal),submission);
          if(admitted.status==='REJECTED')return 'PUBLICATION_UNAVAILABLE';
          const record=await deliveries.claim(identity);
          const state=await publisher.reconcile(record);return state==='UNAVAILABLE'||state==='IDENTITY_BLOCKED'?'PUBLICATION_UNAVAILABLE':'CORE';
        });
      }catch{return 'PUBLICATION_UNAVAILABLE';}
    },
    async reconcileDeliveries(limit:number):Promise<void>{
      for(const record of await deliveries.pending(limit))await publisher.reconcile(record);
    },
  };
}
