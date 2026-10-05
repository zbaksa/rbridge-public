import type {RBridgeExecutionReceiptV1,RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from './rbridgeExecutionContract.js';
export interface RBridgeScope{operationId:string;principalId:string;targetInstanceId:string;}
export type RBridgeCoreRejection='RBRIDGE_CORE_INTENT_COLLISION'|'RBRIDGE_CORE_SCOPE_INVALID'|'RBRIDGE_CORE_LEGACY_ID_RESERVED'|'RBRIDGE_CORE_CAPACITY_REACHED';
export type RBridgeCoreSubmitResult={status:'RECEIPT';receipt:RBridgeExecutionReceiptV1}|({status:'REJECTED';reason:RBridgeCoreRejection}&RBridgeScope);
export type RBridgeCoreLookupResult={status:'RECEIPT';receipt:RBridgeExecutionReceiptV1}|({status:'NOT_FOUND'}&RBridgeScope);
export type RBridgeCoreResultPage={status:'RESULT';receipt:RBridgeExecutionReceiptV1;resultSha256:string;cursor:number;nextCursor:number;eof:boolean;dataBase64:string}|{status:'NOT_READY';receipt:RBridgeExecutionReceiptV1}|({status:'NOT_FOUND'}&RBridgeScope);
export type RBridgeCoreCancellationResult={status:'REQUESTED'|'UNCHANGED_TERMINAL';receipt:RBridgeExecutionReceiptV1}|({status:'NOT_FOUND'}&RBridgeScope)|({status:'REJECTED';reason:'RBRIDGE_CORE_SCOPE_INVALID'|'RBRIDGE_CORE_INTENT_COLLISION'}&RBridgeScope);
export interface RBridgeCorePort{
  submit(submission:RBridgeOperationSubmissionV1,context:RBridgeTransportContextV1,signal:AbortSignal):Promise<RBridgeCoreSubmitResult>;
  status(operationId:string,context:RBridgeTransportContextV1):Promise<RBridgeCoreLookupResult>;
  result(operationId:string,cursor:number,maxBytes:number,context:RBridgeTransportContextV1):Promise<RBridgeCoreResultPage>;
  requestCancel(operationId:string,intentSha256:string,context:RBridgeTransportContextV1):Promise<RBridgeCoreCancellationResult>;
}
export const RBRIDGE_ENABLED_ACTIONS=Object.freeze(['HEALTH/STATUS','FILE/LIST','FILE/STAT','FILE/READ','FILE/READ_MANY','FILE/READ_BINARY','FILE/SEARCH'] as const);
export type RBridgeEnabledAction=typeof RBRIDGE_ENABLED_ACTIONS[number];
export interface RBridgeCoreBinding{schema:'RBRIDGE_CORE_BINDING_V1';journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1';runtimeUid:number;principalId:string;targetInstanceId:string;policySha256:string;enabledActions:readonly RBridgeEnabledAction[];}
export type RBridgeDeploymentBinding=Pick<RBridgeCoreBinding,'runtimeUid'|'principalId'|'targetInstanceId'>;
export type RBridgeCoreRpcRequest=
  |{schema:'RBRIDGE_CORE_RPC_V1';action:'BINDING'}
  |{schema:'RBRIDGE_CORE_RPC_V1';action:'SUBMIT';submission:RBridgeOperationSubmissionV1}
  |{schema:'RBRIDGE_CORE_RPC_V1';action:'STATUS';operationId:string}
  |{schema:'RBRIDGE_CORE_RPC_V1';action:'RESULT';operationId:string;cursor:number;maxBytes:number}
  |{schema:'RBRIDGE_CORE_RPC_V1';action:'CANCEL_INTENT';operationId:string;intentSha256:string};
export type RBridgeCoreRpcResponse={schema:'RBRIDGE_CORE_RPC_RESULT_V1';action:RBridgeCoreRpcRequest['action'];value:RBridgeCoreBinding|RBridgeCoreSubmitResult|RBridgeCoreLookupResult|RBridgeCoreResultPage|RBridgeCoreCancellationResult}|{schema:'RBRIDGE_CORE_RPC_ERROR_V1';reason:'RBRIDGE_CORE_RPC_INVALID'|'RBRIDGE_CORE_RPC_LIMIT'|'RBRIDGE_CORE_RPC_UNAVAILABLE'};
const CORE_LIMITS_VALUES={submissionBytes:65536,depth:16,nodes:4096,requestBytes:65536,responseBytes:131072,nonterminal:128,handlers:4,connections:64,identities:10000,deliveries:10000,recordBytes:131072,journalBytes:67108864,resultBytes:536870912,outputBytes:8388608,pageBytes:32768,readBytes:1048576,paths:32,listEntries:500,searchMatches:500,scanEntries:10000,searchDepth:32,frameMs:5000,rpcMs:10000,handlerMs:10000,stateEntryLimit:40000};
export const RBRIDGE_CORE_LIMITS:Readonly<Record<keyof typeof CORE_LIMITS_VALUES,number>>=Object.freeze(CORE_LIMITS_VALUES);
