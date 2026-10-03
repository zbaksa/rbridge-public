import { createHash, timingSafeEqual } from 'node:crypto';

export interface FlowPilotBridgeAuthority {
  callbackToken: string;
  callbackUrl: string;
}

export interface FlowPilotBridgeOperation {
  schema: 'FLOWPILOT_REMOTE_BRIDGE_V1';
  operationId: string;
  runId: string;
  stepId: string;
  attempt: number;
  fencingToken: number;
  idempotencyKey: string;
  appId: 'fpilot';
  action: 'APP_PROBE_V1';
  payload: Record<string, never>;
  timeoutSeconds: number;
  callbackUrl: string;
}

export interface FlowPilotAppExecutionRequest {
  appId: 'fpilot';
  jobId: string;
  payload: {
    tool: 'probe';
    cwd: '/home/fpilot/backend';
    args: string[];
    timeout_ms: number;
    max_bytes: 32768;
  };
}

const FIELDS = new Set([
  'schema', 'operationId', 'runId', 'stepId', 'attempt', 'fencingToken',
  'idempotencyKey', 'appId', 'action', 'payload', 'timeoutSeconds', 'callback',
]);
const CALLBACK_FIELDS = new Set(['url', 'bearerToken']);
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,191}$/;
const APP_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function fail(code: string): never { throw new Error(code); }
function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function exactFields(value: Record<string, unknown>, expected: Set<string>, code: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) fail(code);
}
function safeText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(code);
  return value;
}
function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}
function tokenEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
  }
  return value;
}

export function parseFlowPilotBridgeEnvelope(
  value: unknown,
  authority: FlowPilotBridgeAuthority,
): FlowPilotBridgeOperation {
  const raw = record(value, 'FLOWPILOT_ENVELOPE_INVALID');
  exactFields(raw, FIELDS, 'FLOWPILOT_ENVELOPE_FIELDS_INVALID');
  if (raw.schema !== 'FLOWPILOT_REMOTE_BRIDGE_V1') fail('FLOWPILOT_SCHEMA_INVALID');
  const operationId = safeText(raw.operationId, 'FLOWPILOT_OPERATION_ID_INVALID');
  const runId = safeText(raw.runId, 'FLOWPILOT_RUN_ID_INVALID');
  const stepId = safeText(raw.stepId, 'FLOWPILOT_STEP_ID_INVALID');
  const idempotencyKey = safeText(raw.idempotencyKey, 'FLOWPILOT_IDEMPOTENCY_KEY_INVALID');
  const appId = raw.appId;
  if (typeof appId !== 'string' || !APP_ID.test(appId)) fail('FLOWPILOT_APP_ID_INVALID');
  if (appId !== 'fpilot') fail('FLOWPILOT_APP_NOT_ALLOWED');
  if (raw.action !== 'APP_PROBE_V1') fail('FLOWPILOT_ACTION_NOT_ALLOWED');
  const payload = record(raw.payload, 'FLOWPILOT_PAYLOAD_INVALID');
  if (Object.keys(payload).length !== 0) fail('FLOWPILOT_PAYLOAD_NOT_ALLOWED');
  const callback = record(raw.callback, 'FLOWPILOT_CALLBACK_INVALID');
  exactFields(callback, CALLBACK_FIELDS, 'FLOWPILOT_CALLBACK_FIELDS_INVALID');
  if (callback.url !== authority.callbackUrl) fail('FLOWPILOT_CALLBACK_URL_INVALID');
  if (!tokenEqual(callback.bearerToken, authority.callbackToken)) fail('FLOWPILOT_CALLBACK_AUTH_INVALID');
  return {
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId, runId, stepId,
    attempt: integer(raw.attempt, 1, 10, 'FLOWPILOT_ATTEMPT_INVALID'),
    fencingToken: integer(raw.fencingToken, 1, Number.MAX_SAFE_INTEGER, 'FLOWPILOT_FENCE_INVALID'),
    idempotencyKey, appId: 'fpilot', action: 'APP_PROBE_V1', payload: {},
    timeoutSeconds: integer(raw.timeoutSeconds, 1, 1800, 'FLOWPILOT_TIMEOUT_INVALID'),
    callbackUrl: authority.callbackUrl,
  };
}

export function flowPilotOperationDigest(operation: FlowPilotBridgeOperation): string {
  return createHash('sha256').update(JSON.stringify(canonical(operation))).digest('hex');
}

export function toFlowPilotAppExecution(operation: FlowPilotBridgeOperation): FlowPilotAppExecutionRequest {
  const suffix = createHash('sha256').update(operation.operationId).digest('hex').slice(0, 48);
  return {
    appId: 'fpilot', jobId: `fp-${suffix}`,
    payload: {
      tool: 'probe', cwd: '/home/fpilot/backend', args: [],
      timeout_ms: operation.timeoutSeconds * 1000, max_bytes: 32768,
    },
  };
}
