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

it('only the fpilot canary identity is currently authorized', () => {
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ appId: 'cocwin' }), authority), /FLOWPILOT_APP_NOT_ALLOWED/);
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ appId: '../root' }), authority), /FLOWPILOT_APP_ID_INVALID/);
});

it('unknown envelope fields and oversize timeout are rejected', () => {
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ surprise: true }), authority), /FLOWPILOT_ENVELOPE_FIELDS_INVALID/);
  assert.throws(() => parseFlowPilotBridgeEnvelope(envelope({ timeoutSeconds: 1801 }), authority), /FLOWPILOT_TIMEOUT_INVALID/);
});
