import assert from 'node:assert/strict';
import {it} from 'vitest';
import {
  flowPilotOperationDigest,
  parseFlowPilotBridgeEnvelope,
  toFlowPilotAppExecution,
} from '../../src/domain/flowPilotBridgeProtocol.js';

const callbackToken = 'c'.repeat(40);
const callbackUrl = 'http://127.0.0.1:8097/api/v1/executor/callback';
const authority = { callbackToken, callbackUrl };
const policySha = 'e6609b939f5d6b93feaf0f715252766965ca4f226b3d419b6ed81927c39cb36c';

function envelope(extra: Record<string, unknown> = {}) {
  return {
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
    operationId: 'op_run_0000000001_probe_a1',
    runId: 'run_0000000001',
    stepId: 'probe',
    attempt: 1,
    fencingToken: 7,
    idempotencyKey: 'fp:run_0000000001:probe:1',
    appId: 'fpilot',
    action: 'APP_PROBE_V1',
    payload: {},
    timeoutSeconds: 60,
    callback: { url: callbackUrl, bearerToken: callbackToken },
    ...extra,
  };
}

function policyEnvelope(extra: Record<string, unknown> = {}) {
  return envelope({
    operationId: 'op_run_0000000002_policy_a1',
    runId: 'run_0000000002',
    stepId: 'policy',
    idempotencyKey: 'fp:run_0000000002:policy:1',
    appId: 'cocwin',
    action: 'COCWIN_MASTER_POLICY_HEALTH_V1',
    payload: { expectedPolicySha256: policySha },
    ...extra,
  });
}

it('valid canary envelope is sanitized and mapped to one source-controlled app profile', () => {
  const parsed = parseFlowPilotBridgeEnvelope(envelope(), authority);
  assert.equal(JSON.stringify(parsed).includes(callbackToken), false);
  assert.deepEqual(toFlowPilotAppExecution(parsed), {
    appId: 'fpilot',
    jobId: 'fp-bf8d03387b1bb6aa7152d720850bcd25c351cf05627132df',
    payload: {
      tool: 'probe', cwd: '/home/fpilot/backend', args: [], timeout_ms: 60_000, max_bytes: 32_768,
    },
  });
});

it('COCWIN policy health maps only to a fixed read-only execution program', () => {
  const parsed = parseFlowPilotBridgeEnvelope(policyEnvelope(), authority);
  assert.equal(parsed.appId, 'cocwin');
  assert.equal(parsed.action, 'COCWIN_MASTER_POLICY_HEALTH_V1');
  const request = toFlowPilotAppExecution(parsed);
  assert.equal(request.appId, 'cocwin');
  assert.match(request.jobId, /^fp-cw-[0-9a-f]{48}$/);
  assert.equal(request.payload.tool, 'node');
  assert.equal(request.payload.cwd, '/home/cocwin/backend');
  assert.equal(request.payload.args[0], '-e');
  assert.match(request.payload.args[1] ?? '', /\/api\/v1\/automation-engine\/policy/);
  assert.match(request.payload.args[1] ?? '', /COCWIN_MASTER_POLICY_MISMATCH/);
  assert.equal(request.payload.args[2], policySha);
  assert.equal(request.payload.timeout_ms, 60_000);
  assert.equal(request.payload.max_bytes, 32_768);
});

it('policy health payload is exact and SHA constrained', () => {
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(policyEnvelope({ payload: {} }), authority),
    /FLOWPILOT_PAYLOAD_NOT_ALLOWED/,
  );
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(policyEnvelope({ payload: { expectedPolicySha256: 'nope' } }), authority),
    /FLOWPILOT_POLICY_SHA_INVALID/,
  );
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(policyEnvelope({ payload: { expectedPolicySha256: policySha, command: 'id' } }), authority),
    /FLOWPILOT_PAYLOAD_NOT_ALLOWED/,
  );
});

it('action is bound to the allowed app identity', () => {
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(envelope({ appId: 'cocwin' }), authority),
    /FLOWPILOT_ACTION_NOT_ALLOWED/,
  );
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(policyEnvelope({ appId: 'fpilot' }), authority),
    /FLOWPILOT_ACTION_NOT_ALLOWED/,
  );
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(envelope({ appId: 'other' }), authority),
    /FLOWPILOT_APP_NOT_ALLOWED/,
  );
  assert.throws(
    () => parseFlowPilotBridgeEnvelope(envelope({ appId: '../root' }), authority),
    /FLOWPILOT_APP_ID_INVALID/,
  );
});

it('operation digest is stable across object key order and excludes bearer material', () => {
  const first = parseFlowPilotBridgeEnvelope(envelope(), authority);
  const reordered = parseFlowPilotBridgeEnvelope({
    callback: { bearerToken: callbackToken, url: callbackUrl },
    timeoutSeconds: 60, payload: {}, action: 'APP_PROBE_V1', appId: 'fpilot',
    idempotencyKey: 'fp:run_0000000001:probe:1', fencingToken: 7, attempt: 1,
    stepId: 'probe', runId: 'run_0000000001', operationId: 'op_run_0000000001_probe_a1',
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
  }, authority);
  assert.equal(flowPilotOperationDigest(first), flowPilotOperationDigest(reordered));
  assert.equal(JSON.stringify(first).includes(callbackToken), false);
});

it('unknown action and nonempty canary payload fail closed', () => {
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ action: 'BUILD_SOURCE' }), authority), /FLOWPILOT_ACTION_NOT_ALLOWED/);
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ payload: { command: 'id' } }), authority), /FLOWPILOT_PAYLOAD_NOT_ALLOWED/);
});

it('callback authority and target are fixed by configuration', () => {
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ callback: { url: callbackUrl, bearerToken: 'x'.repeat(40) } }), authority), /FLOWPILOT_CALLBACK_AUTH_INVALID/);
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ callback: { url: 'http://127.0.0.1:9999/capture', bearerToken: callbackToken } }), authority), /FLOWPILOT_CALLBACK_URL_INVALID/);
});

it('unknown envelope fields and oversize timeout are rejected', () => {
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ surprise: true }), authority), /FLOWPILOT_ENVELOPE_FIELDS_INVALID/);
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ timeoutSeconds: 1801 }), authority), /FLOWPILOT_TIMEOUT_INVALID/);
});
