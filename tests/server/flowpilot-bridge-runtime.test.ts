import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {it} from 'vitest';
import { createFlowPilotBridgeRuntime } from '../../src/server/flowPilotBridgeRuntime.js';

const remoteBridgeToken = 'b'.repeat(40), callbackToken = 'c'.repeat(40);
const policyUrl = 'http://127.0.0.1:18088/api/v1/automation-engine/policy';
function envelope(callbackUrl: string) { return {
  schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId: 'op_run_0000000001_probe_a1', runId: 'run_0000000001',
  stepId: 'probe', attempt: 1, fencingToken: 7, idempotencyKey: 'fp:run_0000000001:probe:1',
  appId: 'fpilot', action: 'APP_PROBE_V1', payload: {}, timeoutSeconds: 60,
  callback: { url: callbackUrl, bearerToken: callbackToken },
}; }

function policyEnvelope(callbackUrl: string) { return {
  schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId: 'op_run_0000000002_policy_a1', runId: 'run_0000000002',
  stepId: 'policy', attempt: 1, fencingToken: 8, idempotencyKey: 'fp:run_0000000002:policy:1',
  appId: 'cocwin', action: 'COCWIN_MASTER_POLICY_HEALTH_V1',
  payload: { expectedPolicySha256: 'e6609b939f5d6b93feaf0f715252766965ca4f226b3d419b6ed81927c39cb36c' },
  timeoutSeconds: 60, callback: { url: callbackUrl, bearerToken: callbackToken },
}; }


function cocwinEmptyEnvelope(
  callbackUrl: string,
  action: 'COCWIN_REFRESH_SNAPSHOT_V1' | 'COCWIN_CONTINUOUS_QUALIFICATION_V1',
  operationId: string,
  runId: string,
  stepId: string,
  fencingToken: number,
  timeoutSeconds: number,
) {
  return {
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
    operationId,
    runId,
    stepId,
    attempt: 1,
    fencingToken,
    idempotencyKey: `fp:${runId}:${stepId}:1`,
    appId: 'cocwin',
    action,
    payload: {},
    timeoutSeconds,
    callback: { url: callbackUrl, bearerToken: callbackToken },
  };
}

it('runtime is absent unless explicitly enabled and secrets must be distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-runtime-'));
  const controller = { async submit() { return { state: 'RUNNING' }; }, async status() { return { state: 'RUNNING' }; }, async result() { return {}; } };
  assert.equal(createFlowPilotBridgeRuntime({ root, controller, env: {} }), undefined);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true' } }), /FLOWPILOT_INGRESS_SECRET_MISSING/);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: remoteBridgeToken } }), /FLOWPILOT_INGRESS_SECRETS_MUST_DIFFER/);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: callbackToken, COCWIN_FLOWPILOT_CALLBACK_URL: 'https://example.com/api/v1/executor/callback' } }), /FLOWPILOT_CALLBACK_URL_INVALID/);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: callbackToken, COCWIN_FLOWPILOT_CALLBACK_URL: 'http://localhost:8097/api/v1/executor/callback' } }), /FLOWPILOT_CALLBACK_URL_INVALID/);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, host: 'localhost', env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: callbackToken } }), /FLOWPILOT_INGRESS_HOST_INVALID/);
  assert.throws(() => createFlowPilotBridgeRuntime({ root, controller, env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: callbackToken, COCWIN_FLOWPILOT_INGRESS_PORT: '0' } }), /FLOWPILOT_INGRESS_PORT_INVALID/);
});

it('loopback ingress persists acceptance, reconciles app result, and sends authenticated callback', async () => {
  const callbacks: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    callbacks.push({ authorization: String(request.headers.authorization), body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const callbackAddress = callbackServer.address(); if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('callback address');
  const callbackUrl = `http://127.0.0.1:${callbackAddress.port}/api/v1/executor/callback`;
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-runtime-'));
  let job = '';
  const runtime = createFlowPilotBridgeRuntime({
    root, host: '127.0.0.1', port: 0,
    env: { COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true', FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken, FLOWPILOT_CALLBACK_TOKEN: callbackToken, COCWIN_FLOWPILOT_CALLBACK_URL: callbackUrl },
    controller: {
      async submit(_app, value) { job = value; return { state: 'RUNNING' }; },
      async status() { return { state: 'SUCCEEDED' }; },
      async result() { return { schema: 'COCWIN_APP_EXECUTION_RESULT_V1', app: 'fpilot', job, state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false }; },
    },
  });
  assert.ok(runtime);
  try {
    const address = await runtime.start();
    assert.equal(address.host, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/execute`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` }, body: JSON.stringify(envelope(callbackUrl)) });
    assert.equal(response.status, 202);
    await runtime.reconcile();
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]?.authorization, `Bearer ${callbackToken}`);
    assert.equal(callbacks[0]?.body.outcome, 'PASS');
    const files = await readdir(join(root, 'flowpilot'));
    const raw = await readFile(join(root, 'flowpilot', files.find((name) => name.endsWith('.json'))!), 'utf8');
    assert.equal(raw.includes(remoteBridgeToken) || raw.includes(callbackToken), false);
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
});


it('policy-health ingress maps to cocwin fixed controller execution and specific callback evidence', async () => {
  const callbacks: Record<string, unknown>[] = [];
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    callbacks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const address = callbackServer.address(); if (!address || typeof address === 'string') throw new Error('callback address');
  const callbackUrl = `http://127.0.0.1:${address.port}/api/v1/executor/callback`;
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-runtime-'));
  const submitted: Array<{ app: string; payload: unknown }> = [];
  const runtime = createFlowPilotBridgeRuntime({
    root, host: '127.0.0.1', port: 0,
    env: {
      COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true',
      FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken,
      FLOWPILOT_CALLBACK_TOKEN: callbackToken,
      COCWIN_FLOWPILOT_CALLBACK_URL: callbackUrl,
      RBRIDGE_COCWIN_POLICY_URL: policyUrl,
    },
    controller: {
      async submit(app, _job, payload) { submitted.push({ app, payload }); return { state: 'RUNNING' }; },
      async status() { return { state: 'SUCCEEDED' }; },
      async result() { return { schema: 'COCWIN_APP_EXECUTION_RESULT_V1', app: 'cocwin', job: 'fixed', state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false }; },
    },
  });
  assert.ok(runtime);
  try {
    const ingress = await runtime.start();
    const response = await fetch(`http://127.0.0.1:${ingress.port}/v1/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${remoteBridgeToken}` },
      body: JSON.stringify(policyEnvelope(callbackUrl)),
    });
    assert.equal(response.status, 202);
    await runtime.reconcile();
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.app, 'cocwin');
    const payload = submitted[0]?.payload as Record<string, unknown>;
    assert.equal(payload.tool, 'node');
    assert.equal(payload.cwd, '/home/cocwin/backend');
    const args = payload.args as string[];
    assert.equal(args[3], policyUrl);
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]?.outcome, 'PASS');
    const evidence = callbacks[0]?.evidence as Record<string, unknown>;
    assert.equal(evidence.schema, 'COCWIN_FLOWPILOT_MASTER_POLICY_HEALTH_EVIDENCE_V1');
    assert.equal(evidence.expectedPolicySha256, 'e6609b939f5d6b93feaf0f715252766965ca4f226b3d419b6ed81927c39cb36c');
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
});


it('public-safe cocwin empty-payload ingress actions map to action evidence', async () => {
  const cases = [
    {
      action: 'COCWIN_REFRESH_SNAPSHOT_V1' as const,
      operationId: 'op_run_0000000004_refresh_a1',
      runId: 'run_0000000004',
      stepId: 'refresh',
      fencingToken: 9,
      timeoutSeconds: 60,
      schema: 'COCWIN_FLOWPILOT_REFRESH_SNAPSHOT_EVIDENCE_V1',
      marker: 'COCWIN_REFRESH_NOT_ADVANCED',
    },
    {
      action: 'COCWIN_CONTINUOUS_QUALIFICATION_V1' as const,
      operationId: 'op_run_0000000005_qualify_a1',
      runId: 'run_0000000005',
      stepId: 'qualify',
      fencingToken: 10,
      timeoutSeconds: 600,
      schema: 'COCWIN_FLOWPILOT_CONTINUOUS_QUALIFICATION_EVIDENCE_V1',
      marker: 'COCWIN_CONTINUOUS_QUALIFICATION_BLOCKED',
    },
    {
      action: 'COCWIN_DEVELOPMENT_SUPERVISOR_V1' as const,
      operationId: 'op_run_0000000006_supervisor_a1',
      runId: 'run_0000000006',
      stepId: 'supervisor',
      fencingToken: 11,
      timeoutSeconds: 60,
      schema: 'COCWIN_FLOWPILOT_DEVELOPMENT_SUPERVISOR_EVIDENCE_V1',
      marker: 'COCWIN_SUPERVISOR_RESULT_INVALID',
    },
  ];

  for (const row of cases) {
    const callbacks: Record<string, unknown>[] = [];

    const callbackServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }

      callbacks.push(
        JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        ) as Record<string, unknown>,
      );

      response.writeHead(200);
      response.end('{}');
    });

    await new Promise<void>((resolve) =>
      callbackServer.listen(0, '127.0.0.1', resolve));

    const address = callbackServer.address();

    if (!address || typeof address === 'string') {
      throw new Error('callback address');
    }

    const callbackUrl =
      `http://127.0.0.1:${address.port}/api/v1/executor/callback`;

    const root = await mkdtemp(join(tmpdir(), 'flowpilot-runtime-'));
    const submitted: Array<{ app: string; payload: unknown }> = [];

    const runtime = createFlowPilotBridgeRuntime({
      root,
      host: '127.0.0.1',
      port: 0,
      env: {
        COCWIN_FLOWPILOT_INGRESS_ENABLED: 'true',
        FLOWPILOT_REMOTE_BRIDGE_TOKEN: remoteBridgeToken,
        FLOWPILOT_CALLBACK_TOKEN: callbackToken,
        COCWIN_FLOWPILOT_CALLBACK_URL: callbackUrl,
        RBRIDGE_COCWIN_POLICY_URL: policyUrl,
      },
      controller: {
        async submit(app, _job, payload) {
          submitted.push({ app, payload });
          return { state: 'RUNNING' };
        },
        async status() {
          return { state: 'SUCCEEDED' };
        },
        async result() {
          return {
            schema: 'COCWIN_APP_EXECUTION_RESULT_V1',
            app: 'cocwin',
            job: row.stepId,
            state: 'SUCCEEDED',
            returncode: 0,
            timed_out: false,
            truncated: false,
          };
        },
      },
    });

    assert.ok(runtime);

    try {
      const ingress = await runtime.start();

      const response = await fetch(
        `http://127.0.0.1:${ingress.port}/v1/execute`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${remoteBridgeToken}`,
          },
          body: JSON.stringify(
            cocwinEmptyEnvelope(
              callbackUrl,
              row.action,
              row.operationId,
              row.runId,
              row.stepId,
              row.fencingToken,
              row.timeoutSeconds,
            ),
          ),
        },
      );

      assert.equal(response.status, 202);

      await runtime.reconcile();

      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]?.app, 'cocwin');

      const payload = submitted[0]?.payload as Record<string, unknown>;
      const args = payload.args as string[];

      assert.equal(payload.tool, 'node');
      assert.equal(payload.cwd, '/home/cocwin/backend');
      assert.match(args[1] ?? '', new RegExp(row.marker));
      assert.doesNotMatch(args[1] ?? '', /192\.168\./);
      assert.equal(args[2], 'http://127.0.0.1:18088');

      assert.equal(callbacks.length, 1);
      assert.equal(callbacks[0]?.outcome, 'PASS');

      const evidence =
        callbacks[0]?.evidence as Record<string, unknown>;

      assert.equal(evidence.schema, row.schema);
      assert.equal(evidence.action, row.action);
    } finally {
      await runtime.stop();

      await new Promise<void>((resolve) =>
        callbackServer.close(() => resolve()));
    }
  }
});
