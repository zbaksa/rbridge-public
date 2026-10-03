import { createHash } from 'node:crypto';
import {
  flowPilotOperationDigest,
  toFlowPilotAppExecution,
  type FlowPilotBridgeOperation,
} from '../domain/flowPilotBridgeProtocol.js';

export type FlowPilotBridgePhase = 'CLAIMED' | 'SUBMITTED' | 'CALLBACK_PENDING' | 'COMPLETED';
export interface FlowPilotBridgeRecord {
  operation: FlowPilotBridgeOperation;
  digest: string;
  appId: string;
  jobId: string;
  phase: FlowPilotBridgePhase;
  callback?: Record<string, unknown>;
}
export interface FlowPilotBridgeStore {
  claim(record: FlowPilotBridgeRecord): Promise<{ state: 'NEW' | 'REPLAY' | 'COLLISION'; record: FlowPilotBridgeRecord }>;
  get(operationId: string): Promise<FlowPilotBridgeRecord | undefined>;
  markSubmitted(operationId: string): Promise<void>;
  markCallbackPending(operationId: string, callback: Record<string, unknown>): Promise<void>;
  markCompleted(operationId: string): Promise<void>;
  pending(): Promise<{ records: FlowPilotBridgeRecord[]; failures: number }>;
}
interface ControllerPort {
  submit(app: string, job: string, payload: unknown): Promise<Record<string, unknown>>;
  status(app: string, job: string): Promise<Record<string, unknown>>;
  result(app: string, job: string): Promise<Record<string, unknown>>;
}
interface CallbackPort {
  send(url: string, token: string, callback: Record<string, unknown>): Promise<void>;
}
export interface FlowPilotBridgeGatewayOptions {
  store: FlowPilotBridgeStore;
  controller: ControllerPort;
  callback: CallbackPort;
  callbackToken: string;
}

function resultDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function outcome(value: Record<string, unknown>): 'PASS' | 'FAIL' | 'UNKNOWN' | 'BLOCKED' {
  if (value.timed_out === true || value.truncated === true || value.state === 'UNCERTAIN') return 'UNKNOWN';
  if (value.state === 'SUCCEEDED') return 'PASS';
  if (value.state === 'FAILED') return 'FAIL';
  if (value.state === 'BLOCKED') return 'BLOCKED';
  throw new Error('FLOWPILOT_CONTROLLER_STATE_INVALID');
}
function callbackFor(record: FlowPilotBridgeRecord, value: Record<string, unknown>): Record<string, unknown> {
  const resolved = outcome(value);
  return {
    schema: 'FLOWPILOT_CALLBACK_V1',
    operationId: record.operation.operationId,
    fencingToken: record.operation.fencingToken,
    outcome: resolved,
    evidence: {
      schema: 'COCWIN_FLOWPILOT_APP_PROBE_EVIDENCE_V1',
      appId: record.appId,
      jobId: record.jobId,
      state: String(value.state),
      returncode: typeof value.returncode === 'number' ? value.returncode : null,
      timedOut: value.timed_out === true,
      truncated: value.truncated === true,
      resultSha256: resultDigest(value),
    },
    ...(resolved === 'UNKNOWN' ? { error: 'REMOTE_BRIDGE_EXECUTION_UNCERTAIN' } : {}),
    ...(resolved === 'FAIL' ? { error: 'REMOTE_BRIDGE_EXECUTION_FAILED' } : {}),
    ...(resolved === 'BLOCKED' ? { error: 'REMOTE_BRIDGE_EXECUTION_BLOCKED' } : {}),
  };
}

function createOperationSerializer() {
  const tails = new Map<string, Promise<void>>();
  return async function run<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(operationId, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (tails.get(operationId) === tail) tails.delete(operationId);
    }
  };
}

export function createFlowPilotBridgeGateway(options: FlowPilotBridgeGatewayOptions) {
  const runExclusive = createOperationSerializer();
  async function submit(record: FlowPilotBridgeRecord): Promise<Record<string, unknown>> {
    const request = toFlowPilotAppExecution(record.operation);
    const status = await options.controller.submit(request.appId, request.jobId, request.payload);
    await options.store.markSubmitted(record.operation.operationId);
    return status;
  }
  async function deliver(record: FlowPilotBridgeRecord, callback: Record<string, unknown>): Promise<void> {
    await options.callback.send(record.operation.callbackUrl, options.callbackToken, callback);
    await options.store.markCompleted(record.operation.operationId);
  }
  return {
    async accept(operation: FlowPilotBridgeOperation): Promise<{ status: 'ACCEPTED'; operationId: string }> {
      return runExclusive(operation.operationId, async () => {
        const request = toFlowPilotAppExecution(operation);
        const proposed: FlowPilotBridgeRecord = {
          operation, digest: flowPilotOperationDigest(operation), appId: request.appId,
          jobId: request.jobId, phase: 'CLAIMED',
        };
        const claim = await options.store.claim(proposed);
        if (claim.state === 'COLLISION') throw new Error('FLOWPILOT_OPERATION_COLLISION');
        if (claim.state === 'NEW' || claim.record.phase === 'CLAIMED') await submit(claim.record);
        return { status: 'ACCEPTED' as const, operationId: operation.operationId };
      });
    },

    async reconcile(): Promise<{ pending: number; completed: number }> {
      const batch = await options.store.pending();
      let pending = 0, completed = 0, failures = batch.failures;
      for (const initial of batch.records) {
        try {
          const outcome = await runExclusive(initial.operation.operationId, async () => {
            let record = await options.store.get(initial.operation.operationId);
            if (!record || record.phase === 'COMPLETED') return 'SKIPPED' as const;
            if (record.phase === 'CALLBACK_PENDING') {
              if (!record.callback) throw new Error('FLOWPILOT_CALLBACK_RECORD_MISSING');
              await deliver(record, record.callback); return 'COMPLETED' as const;
            }
            let status: Record<string, unknown>;
            if (record.phase === 'CLAIMED') {
              status = await submit(record);
              record = { ...record, phase: 'SUBMITTED' };
            } else {
              status = await options.controller.status(record.appId, record.jobId);
            }
            if (status.state === 'QUEUED' || status.state === 'RUNNING') return 'PENDING' as const;
            let result = status;
            if (status.state === 'SUCCEEDED' || status.state === 'FAILED') {
              result = await options.controller.result(record.appId, record.jobId);
            }
            const callback = callbackFor(record, result);
            await options.store.markCallbackPending(record.operation.operationId, callback);
            await deliver(record, callback);
            return 'COMPLETED' as const;
          });
          if (outcome === 'PENDING') pending += 1;
          if (outcome === 'COMPLETED') completed += 1;
        } catch { failures += 1; }
      }
      if (failures > 0) throw new Error('FLOWPILOT_BRIDGE_RECONCILE_PARTIAL');
      return { pending, completed };
    },
  };
}
