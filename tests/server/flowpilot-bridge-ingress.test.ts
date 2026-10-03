import assert from 'node:assert/strict';
import {it} from 'vitest';
import type { FlowPilotBridgeOperation } from '../../src/domain/flowPilotBridgeProtocol.js';
import { createFlowPilotBridgeIngress } from '../../src/server/flowPilotBridgeIngress.js';

const remoteBridgeToken = 'b'.repeat(40), callbackToken = 'c'.repeat(40);
const callbackUrl = 'http://127.0.0.1:8097/api/v1/executor/callback';
function body(action = 'APP_PROBE_V1') { return {
  schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId: 'op_run_0000000001_probe_a1', runId: 'run_0000000001',
  stepId: 'probe', attempt: 1, fencingToken: 7, idempotencyKey: 'fp:run_0000000001:probe:1',
  appId: 'fpilot', action, payload: {}, timeoutSeconds: 60,
  callback: { url: callbackUrl, bearerToken: callbackToken },
}; }
async function fixture(accept: (value: FlowPilotBridgeOperation) => Promise<{ status: 'ACCEPTED'; operationId: string }>) {
  const server = createFlowPilotBridgeIngress({ remoteBridgeToken, callbackToken, callbackUrl, maxBodyBytes: 131072, gateway: { accept } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  return { server, url: `http://127.0.0.1:${address.port}/v1/execute` };
}

it('authenticated valid canary is accepted and no callback bearer reaches the gateway', async () => {
  let received: unknown;
  const f = await fixture(async (value) => { received = value; return { status: 'ACCEPTED', operationId: value.operationId }; });
  try {
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(body()) });
    assert.equal(response.status, 202);
    assert.equal(JSON.stringify(received).includes(callbackToken), false);
    assert.deepEqual(await response.json(), { status: 'ACCEPTED', operationId: body().operationId });
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

it('missing bearer is rejected without echoing either configured secret', async () => {
  const f = await fixture(async (value) => ({ status: 'ACCEPTED', operationId: value.operationId }));
  try {
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    const text = await response.text(); assert.equal(response.status, 401);
    assert.equal(text.includes(remoteBridgeToken) || text.includes(callbackToken), false);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

it('unknown action and operation collision are non-retryable 4xx outcomes', async () => {
  const unknown = await fixture(async (value) => ({ status: 'ACCEPTED', operationId: value.operationId }));
  try {
    const response = await fetch(unknown.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(body('BUILD_SOURCE')) });
    assert.equal(response.status, 422);
  } finally { await new Promise<void>((resolve) => unknown.server.close(() => resolve())); }
  const collision = await fixture(async () => { throw new Error('FLOWPILOT_OPERATION_COLLISION'); });
  try {
    const response = await fetch(collision.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(body()) });
    assert.equal(response.status, 409);
  } finally { await new Promise<void>((resolve) => collision.server.close(() => resolve())); }
});

it('controller uncertainty is a redacted retryable 503', async () => {
  const f = await fixture(async () => { throw new Error(`socket failed ${remoteBridgeToken}`); });
  try {
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(body()) });
    const text = await response.text(); assert.equal(response.status, 503); assert.equal(text.includes(remoteBridgeToken), false);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});

it('wrong method and oversized body fail closed', async () => {
  const f = await fixture(async (value) => ({ status: 'ACCEPTED', operationId: value.operationId }));
  try {
    assert.equal((await fetch(f.url, { method: 'GET' })).status, 405);
    assert.equal((await fetch(`${f.url}?debug=true`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(body()) })).status, 404);
    const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify({ ...body(), padding: 'x'.repeat(140000) }) });
    assert.equal(response.status, 413);
  } finally { await new Promise<void>((resolve) => f.server.close(() => resolve())); }
});
