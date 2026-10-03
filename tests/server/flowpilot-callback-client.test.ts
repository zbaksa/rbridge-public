import assert from 'node:assert/strict';
import {it} from 'vitest';
import { createFlowPilotCallbackClient } from '../../src/server/flowPilotCallbackClient.js';

const token = 'c'.repeat(40), url = 'http://127.0.0.1:8097/api/v1/executor/callback';
const callback = { schema: 'FLOWPILOT_CALLBACK_V1', operationId: 'op_1', fencingToken: 7, outcome: 'PASS' };

it('callback uses exact loopback target, bearer, JSON body, and rejects redirects', async () => {
  let captured: { target: string | URL | Request; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (target, init) => {
    captured = init === undefined ? { target } : { target, init };
    return new Response('{}', { status: 200 });
  };
  const client = createFlowPilotCallbackClient({ timeoutMs: 1000, fetchImpl });
  await client.send(url, token, callback);
  assert.ok(captured);
  assert.equal(captured.target, url);
  assert.deepEqual(captured.init?.headers, { 'content-type': 'application/json', authorization: `Bearer ${token}` });
  assert.equal(captured.init?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(captured.init?.body)), callback);
});

it('non-2xx and network failures expose only stable nonsecret error codes', async () => {
  const rejected = createFlowPilotCallbackClient({ timeoutMs: 1000, fetchImpl: async () => new Response(`leak-${token}`, { status: 409 }) });
  await assert.rejects(rejected.send(url, token, callback), (error: unknown) => error instanceof Error && error.message === 'FLOWPILOT_CALLBACK_REJECTED:409');
  const failed = createFlowPilotCallbackClient({ timeoutMs: 1000, fetchImpl: async () => { throw new Error(`Authorization: Bearer ${token}`); } });
  await assert.rejects(failed.send(url, token, callback), (error: unknown) => error instanceof Error && error.message === 'FLOWPILOT_CALLBACK_UNAVAILABLE');
});

it('callback client refuses non-loopback callback destinations', async () => {
  const client = createFlowPilotCallbackClient({ timeoutMs: 1000, fetchImpl: async () => new Response('{}', { status: 200 }) });
  await client.send('http://[::1]:8097/api/v1/executor/callback', token, callback);
  await assert.rejects(client.send('https://example.com/capture', token, callback), /FLOWPILOT_CALLBACK_URL_INVALID/);
});
