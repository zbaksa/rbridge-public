import { createHash, timingSafeEqual } from 'node:crypto';

export interface FlowPilotBridgeAuthority {
  callbackToken: string;
  callbackUrl: string;
}

interface FlowPilotBridgeOperationBase {
  schema: 'FLOWPILOT_REMOTE_BRIDGE_V1';
  operationId: string;
  runId: string;
  stepId: string;
  attempt: number;
  fencingToken: number;
  idempotencyKey: string;
  timeoutSeconds: number;
  callbackUrl: string;
}

export type FlowPilotBridgeOperation =
  | (FlowPilotBridgeOperationBase & {
    appId: 'fpilot';
    action: 'APP_PROBE_V1';
    payload: Record<string, never>;
  })
  | (FlowPilotBridgeOperationBase & {
    appId: 'cocwin';
    action: 'COCWIN_MASTER_POLICY_HEALTH_V1';
    payload: { expectedPolicySha256: string };
  });

export interface FlowPilotAppExecutionRequest {
  appId: 'fpilot' | 'cocwin';
  jobId: string;
  payload: {
    tool: 'probe' | 'node';
    cwd: '/home/fpilot/backend' | '/home/cocwin/backend';
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
const POLICY_PAYLOAD_FIELDS = new Set(['expectedPolicySha256']);
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,191}$/;
const APP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COCWIN_POLICY_PATH = '/api/v1/automation-engine/policy';

const COCWIN_POLICY_HEALTH_PROGRAM = [
  '(async()=>{',
  'const expected=process.argv[1];',
  'const policyUrl=process.argv[2];',
  "const response=await fetch(policyUrl,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});",
  "if(!response.ok)throw new Error('COCWIN_POLICY_HTTP_'+response.status);",
  'const body=await response.json();',
  "if(body?.state!=='PASS'||body?.policySha256!==expected)throw new Error('COCWIN_MASTER_POLICY_MISMATCH');",
  "process.stdout.write(JSON.stringify({schema:'COCWIN_MASTER_POLICY_HEALTH_V1',status:'PASS',policySha256:body.policySha256})+'\\n');",
  "})().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});",
].join('');

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

function cocwinPolicyUrl(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('FLOWPILOT_POLICY_URL_INVALID');
  }
  let url: URL;
  try { url = new URL(value); }
  catch { fail('FLOWPILOT_POLICY_URL_INVALID'); }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password
    || url.pathname !== COCWIN_POLICY_PATH || url.search || url.hash) {
    fail('FLOWPILOT_POLICY_URL_INVALID');
  }
  return url.toString();
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
  if (!['fpilot', 'cocwin'].includes(appId)) fail('FLOWPILOT_APP_NOT_ALLOWED');
  const payload = record(raw.payload, 'FLOWPILOT_PAYLOAD_INVALID');

  let action: FlowPilotBridgeOperation['action'];
  let parsedPayload: FlowPilotBridgeOperation['payload'];
  if (appId === 'fpilot') {
    if (raw.action !== 'APP_PROBE_V1') fail('FLOWPILOT_ACTION_NOT_ALLOWED');
    if (Object.keys(payload).length !== 0) fail('FLOWPILOT_PAYLOAD_NOT_ALLOWED');
    action = 'APP_PROBE_V1';
    parsedPayload = {};
  } else {
    if (raw.action !== 'COCWIN_MASTER_POLICY_HEALTH_V1') fail('FLOWPILOT_ACTION_NOT_ALLOWED');
    exactFields(payload, POLICY_PAYLOAD_FIELDS, 'FLOWPILOT_PAYLOAD_NOT_ALLOWED');
    if (typeof payload.expectedPolicySha256 !== 'string' || !SHA256.test(payload.expectedPolicySha256)) {
      fail('FLOWPILOT_POLICY_SHA_INVALID');
    }
    action = 'COCWIN_MASTER_POLICY_HEALTH_V1';
    parsedPayload = { expectedPolicySha256: payload.expectedPolicySha256 };
  }

  const callback = record(raw.callback, 'FLOWPILOT_CALLBACK_INVALID');
  exactFields(callback, CALLBACK_FIELDS, 'FLOWPILOT_CALLBACK_FIELDS_INVALID');
  if (callback.url !== authority.callbackUrl) fail('FLOWPILOT_CALLBACK_URL_INVALID');
  if (!tokenEqual(callback.bearerToken, authority.callbackToken)) fail('FLOWPILOT_CALLBACK_AUTH_INVALID');

  const base: FlowPilotBridgeOperationBase = {
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId, runId, stepId,
    attempt: integer(raw.attempt, 1, 10, 'FLOWPILOT_ATTEMPT_INVALID'),
    fencingToken: integer(raw.fencingToken, 1, Number.MAX_SAFE_INTEGER, 'FLOWPILOT_FENCE_INVALID'),
    idempotencyKey,
    timeoutSeconds: integer(raw.timeoutSeconds, 1, 1800, 'FLOWPILOT_TIMEOUT_INVALID'),
    callbackUrl: authority.callbackUrl,
  };
  if (appId === 'fpilot') {
    return { ...base, appId: 'fpilot', action: 'APP_PROBE_V1', payload: parsedPayload as Record<string, never> };
  }
  return {
    ...base,
    appId: 'cocwin',
    action: action as 'COCWIN_MASTER_POLICY_HEALTH_V1',
    payload: parsedPayload as { expectedPolicySha256: string },
  };
}

export function flowPilotOperationDigest(operation: FlowPilotBridgeOperation): string {
  return createHash('sha256').update(JSON.stringify(canonical(operation))).digest('hex');
}

export function flowPilotAppIdentity(
  operation: FlowPilotBridgeOperation,
): { appId: 'fpilot' | 'cocwin'; jobId: string } {
  const suffix = createHash('sha256').update(operation.operationId).digest('hex').slice(0, 48);
  return operation.appId === 'fpilot'
    ? { appId: 'fpilot', jobId: `fp-${suffix}` }
    : { appId: 'cocwin', jobId: `fp-cw-${suffix}` };
}

export function toFlowPilotAppExecution(
  operation: FlowPilotBridgeOperation,
  configuredCocwinPolicyUrl?: string,
): FlowPilotAppExecutionRequest {
  const identity = flowPilotAppIdentity(operation);
  if (operation.appId === 'fpilot') {
    return {
      ...identity,
      payload: {
        tool: 'probe', cwd: '/home/fpilot/backend', args: [],
        timeout_ms: operation.timeoutSeconds * 1000, max_bytes: 32768,
      },
    };
  }
  const policyUrl = cocwinPolicyUrl(configuredCocwinPolicyUrl);
  return {
    ...identity,
    payload: {
      tool: 'node',
      cwd: '/home/cocwin/backend',
      args: [
        '-e',
        COCWIN_POLICY_HEALTH_PROGRAM,
        operation.payload.expectedPolicySha256,
        policyUrl,
      ],
      timeout_ms: operation.timeoutSeconds * 1000,
      max_bytes: 32768,
    },
  };
}
