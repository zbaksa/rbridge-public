import type {RBridgeJsonValue} from '../domain/rbridgeExecutionContract.js';
import type {RBridgeCoreResultPage} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionJournal,RBridgeOperationRecordV1} from './rbridgeExecutionJournal.js';
import type {RBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeExecutionResults{commit(id:string,value:RBridgeJsonValue):Promise<{sha256:string;bytes:number}>;page(record:RBridgeOperationRecordV1,cursor:number,maxBytes:number):Promise<RBridgeCoreResultPage>;}
export async function createRBridgeExecutionResults(_options:{root:string;journal:RBridgeExecutionJournal;files?:RBridgeStateFiles}):Promise<RBridgeExecutionResults>{return {commit:async()=>{throw new Error('NOT_IMPLEMENTED');},page:async()=>{throw new Error('NOT_IMPLEMENTED');}};}
