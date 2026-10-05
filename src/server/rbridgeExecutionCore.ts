import type {RBridgeCorePort,RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionJournal} from './rbridgeExecutionJournal.js';
import type {RBridgeExecutionResults} from './rbridgeExecutionResults.js';
import type {RBridgeExecutionPolicy} from './rbridgeExecutionPolicy.js';
import type {RBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
import type {RBridgeReadonlyHandler} from './rbridgeReadonlyHandlers.js';
export interface RBridgeExecutionCoreOptions{
  binding:RBridgeDeploymentBinding;subjects:{GITHUB:string;MCP:string;LOCAL?:string};journal:RBridgeExecutionJournal;results:RBridgeExecutionResults;policy:RBridgeExecutionPolicy;
  legacyReservations:{isReserved(id:string):Promise<boolean>};serializer:RBridgeOperationSerializer;handler:RBridgeReadonlyHandler;now?:()=>Date;
}
export type RBridgeExecutionCore=RBridgeCorePort&{recover():Promise<void>;close():Promise<void>};
export function createRBridgeExecutionCore(options:RBridgeExecutionCoreOptions):RBridgeExecutionCore{void options;return {async submit(){throw new Error('NOT_IMPLEMENTED');},async status(){throw new Error('NOT_IMPLEMENTED');},async result(){throw new Error('NOT_IMPLEMENTED');},async requestCancel(){throw new Error('NOT_IMPLEMENTED');},async recover(){throw new Error('NOT_IMPLEMENTED');},async close(){throw new Error('NOT_IMPLEMENTED');}};}
