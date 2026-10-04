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
  })
  | (FlowPilotBridgeOperationBase & {
    appId: 'cocwin';
    action: 'COCWIN_REFRESH_SNAPSHOT_V1';
    payload: Record<string, never>;
  })
  | (FlowPilotBridgeOperationBase & {
    appId: 'cocwin';
    action: 'COCWIN_CONTINUOUS_QUALIFICATION_V1';
    payload: Record<string, never>;
  })
  | (FlowPilotBridgeOperationBase & {
    appId: 'cocwin';
    action: 'COCWIN_DEVELOPMENT_SUPERVISOR_V1';
    payload: Record<string, never>;
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

const COCWIN_REFRESH_SNAPSHOT_PROGRAM = [
  "const fs=require('node:fs');",
  '(async()=>{',
  'const baseUrl=process.argv[1];',
  "const snapshotUrl=new URL('/api/v1/snapshot',baseUrl).toString();",
  "const refreshUrl=new URL('/internal/refresh',baseUrl).toString();",
  "const secret=fs.readFileSync('/etc/cocwin/refresh.secret','utf8').trim();",
  "if(secret.length<16||secret.length>4096||/\s/.test(secret))throw new Error('COCWIN_REFRESH_SECRET_INVALID');",
  "const read=async()=>{const r=await fetch(snapshotUrl,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw new Error('COCWIN_SNAPSHOT_HTTP_'+r.status);const x=await r.json();if(x?.version!=='COCKPIT_GLOBAL_SNAPSHOT_V1'||typeof x.generatedAt!=='string')throw new Error('COCWIN_SNAPSHOT_INVALID');return x;};",
  'const before=await read();',
  "const response=await fetch(refreshUrl,{method:'POST',headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(30000),redirect:'error'});",
  "if(!response.ok)throw new Error('COCWIN_REFRESH_HTTP_'+response.status);",
  'const body=await response.json();',
  "if(body?.ok!==true)throw new Error('COCWIN_REFRESH_BODY_INVALID');",
  'const after=await read();',
  'const beforeMs=Date.parse(before.generatedAt),afterMs=Date.parse(after.generatedAt);',
  "if(!Number.isFinite(beforeMs)||!Number.isFinite(afterMs)||afterMs<=beforeMs)throw new Error('COCWIN_REFRESH_NOT_ADVANCED');",
  "process.stdout.write(JSON.stringify({schema:'COCWIN_REFRESH_SNAPSHOT_V1',status:'PASS',beforeGeneratedAt:before.generatedAt,afterGeneratedAt:after.generatedAt})+'\\n');",
  "})().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});",
].join('');

const COCWIN_CONTINUOUS_QUALIFICATION_PROGRAM = [
  '(async()=>{',
  'const baseUrl=process.argv[1];',
  "const endpoints=[['health',new URL('/healthz',baseUrl).toString()],['export',new URL('/api/cocwin/export',baseUrl).toString()]];",
  'const checks={};',
  "for(const [name,url] of endpoints){const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});const body=await response.text();if(Buffer.byteLength(body,'utf8')>524288)throw new Error('COCWIN_'+name.toUpperCase()+'_RESPONSE_TOO_LARGE');checks[name]={ok:response.ok,status:response.status};}",
  "if(!Object.values(checks).every((check)=>check.ok))throw new Error('COCWIN_CONTINUOUS_QUALIFICATION_BLOCKED');",
  "process.stdout.write(JSON.stringify({schema:'COCWIN_CONTINUOUS_QUALIFICATION_V1',status:'READY_FOR_AI',checks,checked_at:new Date().toISOString(),limitations:['NO_LOCAL_WORKTREE_ACCESS_PROVEN','NO_GITHUB_CREDENTIAL_PROVEN']})+'\\n');",
  "})().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});",
].join('');


const COCWIN_DEVELOPMENT_SUPERVISOR_PROGRAM = [
  "const fs=require('node:fs');",
  '(async()=>{',
  'const baseUrl=process.argv[1];',
  "const tickUrl=new URL('/internal/automation-supervisor/tick',baseUrl).toString();",
  "const secret=fs.readFileSync('/etc/cocwin/refresh.secret','utf8').trim();",
  "if(secret.length<16||secret.length>4096||/\\s/.test(secret))throw new Error('COCWIN_SUPERVISOR_SECRET_INVALID');",
  "const response=await fetch(tickUrl,{method:'POST',headers:{authorization:'Bearer '+secret,accept:'application/json'},signal:AbortSignal.timeout(55000),redirect:'error'});",
  "const text=await response.text();",
  "if(Buffer.byteLength(text,'utf8')>524288)throw new Error('COCWIN_SUPERVISOR_RESPONSE_TOO_LARGE');",
  "if(!response.ok)throw new Error('COCWIN_SUPERVISOR_HTTP_'+response.status);",
  "let body;try{body=JSON.parse(text);}catch{throw new Error('COCWIN_SUPERVISOR_RESPONSE_INVALID');}",
  "if(body?.schema!=='COCWIN_AUTOMATION_SUPERVISOR_V1')throw new Error('COCWIN_SUPERVISOR_RESULT_INVALID');",
  "if(body?.status!=='PASS')throw new Error('COCWIN_SUPERVISOR_STATUS_'+String(body?.status??'INVALID'));",
  "process.stdout.write(JSON.stringify(body)+'\\n');",
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
    if (raw.action === 'COCWIN_MASTER_POLICY_HEALTH_V1') {
      exactFields(payload, POLICY_PAYLOAD_FIELDS, 'FLOWPILOT_PAYLOAD_NOT_ALLOWED');
      if (typeof payload.expectedPolicySha256 !== 'string' || !SHA256.test(payload.expectedPolicySha256)) {
        fail('FLOWPILOT_POLICY_SHA_INVALID');
      }
      action = 'COCWIN_MASTER_POLICY_HEALTH_V1';
      parsedPayload = { expectedPolicySha256: payload.expectedPolicySha256 };
    } else if (raw.action === 'COCWIN_REFRESH_SNAPSHOT_V1') {
      if (Object.keys(payload).length !== 0) fail('FLOWPILOT_PAYLOAD_NOT_ALLOWED');
      action = 'COCWIN_REFRESH_SNAPSHOT_V1';
      parsedPayload = {};
    } else if (raw.action === 'COCWIN_CONTINUOUS_QUALIFICATION_V1') {
      if (Object.keys(payload).length !== 0) fail('FLOWPILOT_PAYLOAD_NOT_ALLOWED');
      action = 'COCWIN_CONTINUOUS_QUALIFICATION_V1';
      parsedPayload = {};
    } else if (raw.action === 'COCWIN_DEVELOPMENT_SUPERVISOR_V1') {
      if (Object.keys(payload).length !== 0) fail('FLOWPILOT_PAYLOAD_NOT_ALLOWED');
      action = 'COCWIN_DEVELOPMENT_SUPERVISOR_V1';
      parsedPayload = {};
    } else {
      fail('FLOWPILOT_ACTION_NOT_ALLOWED');
    }
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
  if (action === 'COCWIN_MASTER_POLICY_HEALTH_V1') {
    return {
      ...base,
      appId: 'cocwin',
      action,
      payload: parsedPayload as { expectedPolicySha256: string },
    };
  }
  if (action === 'COCWIN_REFRESH_SNAPSHOT_V1') {
    return {
      ...base,
      appId: 'cocwin',
      action,
      payload: {},
    };
  }
  if (action === 'COCWIN_CONTINUOUS_QUALIFICATION_V1') {
    return {
      ...base,
      appId: 'cocwin',
      action,
      payload: {},
    };
  }
  return {
    ...base,
    appId: 'cocwin',
    action: 'COCWIN_DEVELOPMENT_SUPERVISOR_V1',
    payload: {},
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

  if (operation.action === 'COCWIN_MASTER_POLICY_HEALTH_V1') {
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

  const cocwinBaseUrl = new URL(policyUrl).origin;

  if (operation.action === 'COCWIN_REFRESH_SNAPSHOT_V1') {
    return {
      ...identity,
      payload: {
        tool: 'node',
        cwd: '/home/cocwin/backend',
        args: [
          '-e',
          COCWIN_REFRESH_SNAPSHOT_PROGRAM,
          cocwinBaseUrl,
        ],
        timeout_ms: operation.timeoutSeconds * 1000,
        max_bytes: 32768,
      },
    };
  }

  if (operation.action === 'COCWIN_CONTINUOUS_QUALIFICATION_V1') {
    return {
      ...identity,
      payload: {
        tool: 'node',
        cwd: '/home/cocwin/backend',
        args: [
          '-e',
          COCWIN_CONTINUOUS_QUALIFICATION_PROGRAM,
          cocwinBaseUrl,
        ],
        timeout_ms: operation.timeoutSeconds * 1000,
        max_bytes: 32768,
      },
    };
  }

  return {
    ...identity,
    payload: {
      tool: 'node',
      cwd: '/home/cocwin/backend',
      args: [
        '-e',
        COCWIN_DEVELOPMENT_SUPERVISOR_PROGRAM,
        cocwinBaseUrl,
      ],
      timeout_ms: operation.timeoutSeconds * 1000,
      max_bytes: 32768,
    },
  };
}
