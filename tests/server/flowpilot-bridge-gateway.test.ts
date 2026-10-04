import assert from 'node:assert/strict';
import {it} from 'vitest';
import { createFlowPilotBridgeGateway, type FlowPilotBridgeRecord, type FlowPilotBridgeStore } from '../../src/server/flowPilotBridgeGateway.js';
import { parseFlowPilotBridgeEnvelope } from '../../src/domain/flowPilotBridgeProtocol.js';

const callbackToken = 'c'.repeat(40);
const callbackUrl = 'http://127.0.0.1:8097/api/v1/executor/callback';
const authority = { callbackToken, callbackUrl };
const policyUrl = 'http://127.0.0.1:18088/api/v1/automation-engine/policy';

function operation(timeoutSeconds = 60, operationId = 'op_run_0000000001_probe_a1') {
  return parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId,
    runId: 'run_0000000001', stepId: 'probe', attempt: 1, fencingToken: 7,
    idempotencyKey: 'fp:run_0000000001:probe:1', appId: 'fpilot', action: 'APP_PROBE_V1',
    payload: {}, timeoutSeconds, callback: { url: callbackUrl, bearerToken: callbackToken },
  }, authority);
}

function policyOperation() {
  return parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId: 'op_run_0000000002_policy_a1',
    runId: 'run_0000000002', stepId: 'policy', attempt: 1, fencingToken: 8,
    idempotencyKey: 'fp:run_0000000002:policy:1', appId: 'cocwin',
    action: 'COCWIN_MASTER_POLICY_HEALTH_V1',
    payload: { expectedPolicySha256: 'e6609b939f5d6b93feaf0f715252766965ca4f226b3d419b6ed81927c39cb36c' },
    timeoutSeconds: 60, callback: { url: callbackUrl, bearerToken: callbackToken },
  }, authority);
}


function refreshOperation() {
  return parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
    operationId: 'op_run_0000000004_refresh_a1',
    runId: 'run_0000000004',
    stepId: 'refresh',
    attempt: 1,
    fencingToken: 9,
    idempotencyKey: 'fp:run_0000000004:refresh:1',
    appId: 'cocwin',
    action: 'COCWIN_REFRESH_SNAPSHOT_V1',
    payload: {},
    timeoutSeconds: 60,
    callback: { url: callbackUrl, bearerToken: callbackToken },
  }, authority);
}

function qualificationOperation() {
  return parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
    operationId: 'op_run_0000000005_qualify_a1',
    runId: 'run_0000000005',
    stepId: 'qualify',
    attempt: 1,
    fencingToken: 10,
    idempotencyKey: 'fp:run_0000000005:qualify:1',
    appId: 'cocwin',
    action: 'COCWIN_CONTINUOUS_QUALIFICATION_V1',
    payload: {},
    timeoutSeconds: 600,
    callback: { url: callbackUrl, bearerToken: callbackToken },
  }, authority);
}


function supervisorOperation() {
  return parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1',
    operationId: 'op_run_0000000006_supervisor_a1',
    runId: 'run_0000000006',
    stepId: 'supervisor',
    attempt: 1,
    fencingToken: 11,
    idempotencyKey: 'fp:run_0000000006:supervisor:1',
    appId: 'cocwin',
    action: 'COCWIN_DEVELOPMENT_SUPERVISOR_V1',
    payload: {},
    timeoutSeconds: 60,
    callback: { url: callbackUrl, bearerToken: callbackToken },
  }, authority);
}

class MemoryStore implements FlowPilotBridgeStore {
  records = new Map<string, FlowPilotBridgeRecord>();
  events: string[] = [];
  async claim(record: FlowPilotBridgeRecord) {
    this.events.push('claim');
    const existing = this.records.get(record.operation.operationId);
    if (!existing) { this.records.set(record.operation.operationId, structuredClone(record)); return { state: 'NEW' as const, record }; }
    if (existing.digest !== record.digest) return { state: 'COLLISION' as const, record: existing };
    return { state: 'REPLAY' as const, record: structuredClone(existing) };
  }
  async get(operationId: string) {
    const value = this.records.get(operationId);
    return value ? structuredClone(value) : undefined;
  }
  async markSubmitted(operationId: string) { this.events.push('submitted'); this.records.get(operationId)!.phase = 'SUBMITTED'; }
  async markCallbackPending(operationId: string, callback: Record<string, unknown>) {
    this.events.push('callback-persisted'); const record = this.records.get(operationId)!;
    record.phase = 'CALLBACK_PENDING'; record.callback = structuredClone(callback);
  }
  async markCompleted(operationId: string) { this.events.push('completed'); this.records.get(operationId)!.phase = 'COMPLETED'; }
  async pending() { return { records: [...this.records.values()].filter((record) => record.phase !== 'COMPLETED').map((record) => structuredClone(record)), failures: 0 }; }
}

it('accept durably claims before submit and exact replay does not double-submit', async () => {
  const store = new MemoryStore(); let submits = 0;
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: { async submit() { store.events.push('submit'); submits += 1; return { state: 'RUNNING' }; }, async status() { return { state: 'RUNNING' }; }, async result() { throw new Error('not terminal'); } },
    callback: { async send() { throw new Error('not terminal'); } }, callbackToken,
  });
  assert.deepEqual(await gateway.accept(operation()), { status: 'ACCEPTED', operationId: operation().operationId });
  assert.deepEqual(store.events, ['claim', 'submit', 'submitted']);
  await gateway.accept(operation());
  assert.equal(submits, 1);
  assert.equal(JSON.stringify(store.records).includes(callbackToken), false);
});

it('uncertain submit is retried with the same deterministic app job identity', async () => {
  const store = new MemoryStore(); const jobs: string[] = [];
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: { async submit(_app, job) { jobs.push(job); if (jobs.length === 1) throw new Error('transport lost'); return { state: 'RUNNING' }; }, async status() { return { state: 'RUNNING' }; }, async result() { throw new Error('not terminal'); } },
    callback: { async send() {} }, callbackToken,
  });
  await assert.rejects(gateway.accept(operation()), /transport lost/);
  await gateway.accept(operation());
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0], jobs[1]);
  assert.equal(store.records.get(operation().operationId)?.phase, 'SUBMITTED');
});

it('same operation id with changed immutable request is a collision', async () => {
  const store = new MemoryStore();
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: { async submit() { return { state: 'RUNNING' }; }, async status() { return { state: 'RUNNING' }; }, async result() { return {}; } },
    callback: { async send() {} }, callbackToken,
  });
  await gateway.accept(operation());
  await assert.rejects(gateway.accept(operation(61)), /FLOWPILOT_OPERATION_COLLISION/);
});

it('terminal result persists an immutable callback before delivery and safely replays it', async () => {
  const store = new MemoryStore(); const delivered: Record<string, unknown>[] = []; let attempts = 0;
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: {
      async submit() { return { state: 'RUNNING' }; }, async status() { return { state: 'SUCCEEDED' }; },
      async result() { return { schema: 'COCWIN_APP_EXECUTION_RESULT_V1', app: 'fpilot', job: 'fixed', state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false, stdout: 'must-not-leak' }; },
    },
    callback: { async send(_url, token, value) { assert.equal(token, callbackToken); attempts += 1; delivered.push(structuredClone(value)); if (attempts === 1) throw new Error('callback connection lost'); } },
    callbackToken,
  });
  await gateway.accept(operation());
  await assert.rejects(gateway.reconcile(), /FLOWPILOT_BRIDGE_RECONCILE_PARTIAL/);
  assert.equal(store.records.get(operation().operationId)?.phase, 'CALLBACK_PENDING');
  assert.equal(store.events.at(-1), 'callback-persisted');
  await gateway.reconcile();
  assert.deepEqual(delivered[1], delivered[0]);
  assert.equal(JSON.stringify(delivered[0]).includes('must-not-leak'), false);
  assert.equal(delivered[0]?.outcome, 'PASS');
  assert.equal(store.records.get(operation().operationId)?.phase, 'COMPLETED');
});

it('COCWIN policy health uses cocwin controller identity and action-specific evidence', async () => {
  const store = new MemoryStore();
  const delivered: Record<string, unknown>[] = [];
  const submitted: Array<{ app: string; payload: unknown }> = [];
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: {
      async submit(app, _job, payload) { submitted.push({ app, payload }); return { state: 'RUNNING' }; },
      async status() { return { state: 'SUCCEEDED' }; },
      async result() { return { state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false, stdout: 'hidden' }; },
    },
    callback: { async send(_url, _token, value) { delivered.push(value); } },
    callbackToken,
    cocwinPolicyUrl: policyUrl,
  });
  await gateway.accept(policyOperation());
  await gateway.reconcile();
  assert.equal(submitted[0]?.app, 'cocwin');
  const payload = submitted[0]?.payload as Record<string, unknown>;
  assert.equal(payload.tool, 'node');
  assert.equal(payload.cwd, '/home/cocwin/backend');
  const args = payload.args as string[];
  assert.equal(args[3], policyUrl);
  assert.equal(delivered[0]?.outcome, 'PASS');
  const evidence = delivered[0]?.evidence as Record<string, unknown>;
  assert.equal(evidence.schema, 'COCWIN_FLOWPILOT_MASTER_POLICY_HEALTH_EVIDENCE_V1');
  assert.equal(evidence.action, 'COCWIN_MASTER_POLICY_HEALTH_V1');
  assert.equal(evidence.expectedPolicySha256, 'e6609b939f5d6b93feaf0f715252766965ca4f226b3d419b6ed81927c39cb36c');
  assert.equal(JSON.stringify(delivered[0]).includes('hidden'), false);
});


it('COCWIN refresh and qualification use action-specific evidence', async () => {
  const cases = [
    {
      operation: refreshOperation(),
      schema: 'COCWIN_FLOWPILOT_REFRESH_SNAPSHOT_EVIDENCE_V1',
      action: 'COCWIN_REFRESH_SNAPSHOT_V1',
      marker: 'COCWIN_REFRESH_NOT_ADVANCED',
    },
    {
      operation: qualificationOperation(),
      schema: 'COCWIN_FLOWPILOT_CONTINUOUS_QUALIFICATION_EVIDENCE_V1',
      action: 'COCWIN_CONTINUOUS_QUALIFICATION_V1',
      marker: 'COCWIN_CONTINUOUS_QUALIFICATION_BLOCKED',
    },
  ];

  for (const row of cases) {
    const store = new MemoryStore();
    const delivered: Record<string, unknown>[] = [];
    const submitted: Array<{ app: string; payload: unknown }> = [];

    const gateway = createFlowPilotBridgeGateway({
      store,
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
            state: 'SUCCEEDED',
            returncode: 0,
            timed_out: false,
            truncated: false,
            stdout: 'must-not-leak',
          };
        },
      },
      callback: {
        async send(_url, _token, value) {
          delivered.push(value);
        },
      },
      callbackToken,
      cocwinPolicyUrl: policyUrl,
    });

    await gateway.accept(row.operation);
    await gateway.reconcile();

    assert.equal(submitted[0]?.app, 'cocwin');

    const payload = submitted[0]?.payload as Record<string, unknown>;
    const args = payload.args as string[];

    assert.equal(payload.tool, 'node');
    assert.equal(payload.cwd, '/home/cocwin/backend');
    assert.match(args[1] ?? '', new RegExp(row.marker));
    assert.doesNotMatch(args[1] ?? '', /192\.168\./);
    assert.equal(args[2], 'http://127.0.0.1:18088');

    const evidence = delivered[0]?.evidence as Record<string, unknown>;

    assert.equal(delivered[0]?.outcome, 'PASS');
    assert.equal(evidence.schema, row.schema);
    assert.equal(evidence.action, row.action);
    assert.equal(
      JSON.stringify(delivered[0]).includes('must-not-leak'),
      false,
    );
  }
});

it('COCWIN development supervisor uses cocwin identity and supervisor-specific evidence', async () => {
  const store = new MemoryStore();
  const delivered: Record<string, unknown>[] = [];
  const submitted: Array<{ app: string; payload: unknown }> = [];

  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: {
      async submit(app, _job, payload) {
        submitted.push({ app, payload });
        return { state: 'RUNNING' };
      },
      async status() { return { state: 'SUCCEEDED' }; },
      async result() {
        return {
          state: 'SUCCEEDED',
          returncode: 0,
          timed_out: false,
          truncated: false,
          stdout: 'hidden-supervisor',
        };
      },
    },
    callback: {
      async send(_url, _token, value) {
        delivered.push(value);
      },
    },
    callbackToken,
    cocwinPolicyUrl: 'http://127.0.0.1:18088/api/v1/automation-engine/policy',
  });

  await gateway.accept(supervisorOperation());
  await gateway.reconcile();

  assert.equal(submitted[0]?.app, 'cocwin');

  const payload = submitted[0]?.payload as Record<string, unknown>;
  assert.equal(payload.tool, 'node');
  assert.equal(payload.cwd, '/home/cocwin/backend');

  const args = payload.args as string[];
  assert.match(args[1] ?? '', /\/internal\/automation-supervisor\/tick/);
  assert.match(args[1] ?? '', /refresh\.secret/);

  assert.equal(delivered[0]?.outcome, 'PASS');

  const evidence = delivered[0]?.evidence as Record<string, unknown>;
  assert.equal(
    evidence.schema,
    'COCWIN_FLOWPILOT_DEVELOPMENT_SUPERVISOR_EVIDENCE_V1',
  );
  assert.equal(evidence.action, 'COCWIN_DEVELOPMENT_SUPERVISOR_V1');
  assert.equal(
    JSON.stringify(delivered[0]).includes('hidden-supervisor'),
    false,
  );
});

it('timed out or truncated execution resolves to UNKNOWN, never blind FAIL', async () => {
  const store = new MemoryStore(); const delivered: Record<string, unknown>[] = [];
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: { async submit() { return { state: 'RUNNING' }; }, async status() { return { state: 'FAILED' }; }, async result() { return { app: 'fpilot', job: 'fixed', state: 'FAILED', returncode: 1, timed_out: true, truncated: false }; } },
    callback: { async send(_url, _token, value) { delivered.push(value); } }, callbackToken,
  });
  await gateway.accept(operation());
  await gateway.reconcile();
  assert.equal(delivered[0]?.outcome, 'UNKNOWN');
});

it('accept and reconcile are serialized per operation across submit and callback delivery', async () => {
  const store = new MemoryStore(); let submitCalls = 0; let releaseFirst!: () => void;
  const firstSubmitEntered = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let unblockFirst!: () => void;
  const firstSubmitBlocked = new Promise<void>((resolve) => { unblockFirst = resolve; });
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: {
      async submit() {
        submitCalls += 1;
        if (submitCalls === 1) { releaseFirst(); await firstSubmitBlocked; }
        return { state: 'RUNNING' };
      },
      async status() { return { state: 'SUCCEEDED' }; },
      async result() { return { state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false }; },
    },
    callback: { async send() {} }, callbackToken,
  });
  const accepted = gateway.accept(operation()); await firstSubmitEntered;
  const reconciled = gateway.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(submitCalls, 1);
  unblockFirst();
  await accepted; await reconciled;
  assert.equal(store.records.get(operation().operationId)?.phase, 'COMPLETED');
});

it('one failing operation does not starve a later callback', async () => {
  const store = new MemoryStore();
  const first = operation(60, 'op_run_0000000001_probe_a1');
  const second = operation(60, 'op_run_0000000002_probe_a1');
  const delivered: string[] = [];
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: {
      async submit() { return { state: 'RUNNING' }; },
      async status(_app, job) {
        if (job === store.records.get(first.operationId)?.jobId) throw new Error('poison status');
        return { state: 'SUCCEEDED' };
      },
      async result() { return { state: 'SUCCEEDED', returncode: 0, timed_out: false, truncated: false }; },
    },
    callback: { async send(_url, _token, value) { delivered.push(String(value.operationId)); } }, callbackToken,
  });
  await gateway.accept(first); await gateway.accept(second);
  await assert.rejects(gateway.reconcile(), /FLOWPILOT_BRIDGE_RECONCILE_PARTIAL/);
  assert.deepEqual(delivered, [second.operationId]);
  assert.equal(store.records.get(second.operationId)?.phase, 'COMPLETED');
});

it('controller uncertainty matrix never becomes a blind failure', async () => {
  const cases = [
    { state: 'FAILED', timed_out: false, truncated: true },
    { state: 'UNCERTAIN', timed_out: false, truncated: false },
  ];
  for (const [index, result] of cases.entries()) {
    const store = new MemoryStore(); const delivered: Record<string, unknown>[] = [];
    const gateway = createFlowPilotBridgeGateway({
      store,
      controller: { async submit() { return { state: 'RUNNING' }; }, async status() { return result; }, async result() { return result; } },
      callback: { async send(_url, _token, value) { delivered.push(value); } }, callbackToken,
    });
    await gateway.accept(operation(60, `op_run_000000000${index + 3}_probe_a1`));
    await gateway.reconcile();
    assert.equal(delivered[0]?.outcome, 'UNKNOWN');
  }
});
