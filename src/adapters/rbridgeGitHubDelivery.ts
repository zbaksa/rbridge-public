import type {RBridgeGitHubCoreOptions} from './rbridgeGitHubCore.js';
import type {RBridgeGitHubDeliveryRecordV1} from '../server/rbridgeDeliveryJournal.js';
export function createRBridgeGitHubDelivery(_options:RBridgeGitHubCoreOptions){void _options;return {async reconcile(_record:RBridgeGitHubDeliveryRecordV1):Promise<'WAITING'|'PUBLISHED'|'UNAVAILABLE'|'IDENTITY_BLOCKED'>{void _record;throw new Error('NOT_IMPLEMENTED');}};}
