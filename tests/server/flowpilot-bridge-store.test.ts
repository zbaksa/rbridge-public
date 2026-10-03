import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {it} from 'vitest';
import { parseFlowPilotBridgeEnvelope, flowPilotOperationDigest, toFlowPilotAppExecution } from '../../src/domain/flowPilotBridgeProtocol.js';
import type { FlowPilotBridgeRecord } from '../../src/server/flowPilotBridgeGateway.js';
import { createFlowPilotBridgeStore } from '../../src/server/flowPilotBridgeStore.js';

const callbackToken = 'c'.repeat(40), callbackUrl = 'http://127.0.0.1:8097/api/v1/executor/callback';
function record(timeoutSeconds = 60, operationId = 'op_run_0000000001_probe_a1'): FlowPilotBridgeRecord {
  const operation = parseFlowPilotBridgeEnvelope({
    schema: 'FLOWPILOT_REMOTE_BRIDGE_V1', operationId, runId: 'run_0000000001',
    stepId: 'probe', attempt: 1, fencingToken: 7, idempotencyKey: 'fp:run_0000000001:probe:1',
    appId: 'fpilot', action: 'APP_PROBE_V1', payload: {}, timeoutSeconds,
    callback: { url: callbackUrl, bearerToken: callbackToken },
  }, { callbackToken, callbackUrl });
  const app = toFlowPilotAppExecution(operation);
  return { operation, digest: flowPilotOperationDigest(operation), appId: app.appId, jobId: app.jobId, phase: 'CLAIMED' };
}

it('claim is durable, exact replay is stable, and changed digest collides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const store = createFlowPilotBridgeStore(root, () => new Date('2026-09-28T18:00:00.000Z'));
  assert.equal((await store.claim(record())).state, 'NEW');
  assert.equal((await store.claim(record())).state, 'REPLAY');
  assert.equal((await store.claim(record(61))).state, 'COLLISION');
  const reopened = createFlowPilotBridgeStore(root);
  assert.equal((await reopened.claim(record())).state, 'REPLAY');
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, `${record().operation.operationId}.json`))).mode & 0o777, 0o600);
});

it('concurrent conflicting first claims have exactly one durable winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const store = createFlowPilotBridgeStore(root);
  const results = await Promise.all([store.claim(record()), store.claim(record(61))]);
  assert.deepEqual(results.map((value) => value.state).sort(), ['COLLISION', 'NEW']);
  const persisted = (await createFlowPilotBridgeStore(root).pending()).records[0];
  assert.ok(persisted?.digest === record().digest || persisted?.digest === record(61).digest);
});

it('phase and immutable callback survive restart without bearer material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const store = createFlowPilotBridgeStore(root);
  await store.claim(record());
  await store.markSubmitted(record().operation.operationId);
  const callback = { schema: 'FLOWPILOT_CALLBACK_V1', operationId: record().operation.operationId, fencingToken: 7, outcome: 'PASS' };
  await store.markCallbackPending(record().operation.operationId, callback);
  const pending = await createFlowPilotBridgeStore(root).pending();
  assert.equal(pending.records[0]?.phase, 'CALLBACK_PENDING');
  assert.deepEqual(pending.records[0]?.callback, callback);
  const raw = await readFile(join(root, `${record().operation.operationId}.json`), 'utf8');
  assert.equal(raw.includes(callbackToken), false);
  await store.markCompleted(record().operation.operationId);
  assert.deepEqual((await store.pending()).records, []);
});

it('conflicting callback fails closed and corrupt records are reported without hiding healthy work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const store = createFlowPilotBridgeStore(root);
  await store.claim(record()); await store.markSubmitted(record().operation.operationId);
  const first = { schema: 'FLOWPILOT_CALLBACK_V1', operationId: record().operation.operationId, fencingToken: 7, outcome: 'PASS' };
  await store.markCallbackPending(record().operation.operationId, first);
  await assert.rejects(store.markCallbackPending(record().operation.operationId, { ...first, outcome: 'FAIL' }), /FLOWPILOT_BRIDGE_CALLBACK_CONFLICT/);
  await writeFile(join(root, `${record().operation.operationId}.json`), '{}\n');
  const firstScan = await createFlowPilotBridgeStore(root).pending();
  assert.equal(firstScan.failures, 1);
  assert.deepEqual(firstScan.records, []);

  const malformed = {
    schema: 'COCWIN_FLOWPILOT_BRIDGE_STORE_V1',
    operation: { schema: 'FLOWPILOT_REMOTE_BRIDGE_V1' },
    digest: '0'.repeat(64), appId: 'fpilot', jobId: 'fp-invalid', phase: 'CLAIMED',
    createdAt: '2026-09-28T18:00:00.000Z', updatedAt: '2026-09-28T18:00:00.000Z',
  };
  await writeFile(join(root, `${record().operation.operationId}.json`), `${JSON.stringify(malformed)}\n`);
  const secondScan = await createFlowPilotBridgeStore(root).pending();
  assert.equal(secondScan.failures, 1);
  assert.deepEqual(secondScan.records, []);
});

it('state root and records reject symlinks, hardlinks, and invalid JSON', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const actualRoot = join(parent, 'actual'); const linkedRoot = join(parent, 'linked');
  await mkdir(actualRoot, { mode: 0o700 }); await symlink(actualRoot, linkedRoot);
  await assert.rejects(createFlowPilotBridgeStore(linkedRoot).pending(), /FLOWPILOT_BRIDGE_STORE_ROOT_INVALID/);

  const root = join(parent, 'records'); await mkdir(root, { mode: 0o700 });
  const outside = join(parent, 'outside.json'); await writeFile(outside, '{}\n', { mode: 0o600 });
  const linked = join(root, 'linked.json'); await symlink(outside, linked);
  assert.equal((await createFlowPilotBridgeStore(root).pending()).failures, 1);
  await unlink(linked);
  const invalid = join(root, 'invalid.json'); await writeFile(invalid, 'not json\n', { mode: 0o600 });
  assert.equal((await createFlowPilotBridgeStore(root).pending()).failures, 1);
  await unlink(invalid);

  const store = createFlowPilotBridgeStore(root); await store.claim(record());
  await link(join(root, `${record().operation.operationId}.json`), join(root, 'second.json'));
  assert.equal((await createFlowPilotBridgeStore(root).pending()).failures, 2);
});

it('restart recovers the exact interrupted claim hardlink but rejects unrelated hardlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  const store = createFlowPilotBridgeStore(root); await store.claim(record());
  const final = join(root, `${record().operation.operationId}.json`);
  const artifact = `${final}.123.456.deadbeef.claim`;
  await link(final, artifact);
  const recovered = await createFlowPilotBridgeStore(root).pending();
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.records[0]?.phase, 'CLAIMED');
  assert.equal((await stat(final)).nlink, 1);
  assert.equal((await readdir(root)).includes(artifact.split('/').at(-1)!), false);

  await link(final, join(root, 'unrelated.json'));
  assert.equal((await createFlowPilotBridgeStore(root).pending()).failures, 2);
});

it('completed history is compacted without counting against pending work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowpilot-bridge-store-'));
  let clock = new Date('2026-09-01T00:00:00.000Z');
  const store = createFlowPilotBridgeStore(root, () => clock, {
    maxCompletedRecords: 1, completedMinRetentionMs: 1_000, completedRetentionMs: 60_000,
  });
  const first = record(60, 'op_run_0000000001_probe_a1');
  const second = record(60, 'op_run_0000000002_probe_a1');
  for (const value of [first, second]) {
    await store.claim(value); await store.markSubmitted(value.operation.operationId);
    await store.markCallbackPending(value.operation.operationId, {
      schema: 'FLOWPILOT_CALLBACK_V1', operationId: value.operation.operationId,
      fencingToken: value.operation.fencingToken, outcome: 'PASS',
    });
    await store.markCompleted(value.operation.operationId);
    clock = new Date(clock.getTime() + 2_000);
  }
  const active = record(60, 'op_run_0000000003_probe_a1'); await store.claim(active);
  clock = new Date(clock.getTime() + 2_000);
  const scan = await store.pending();
  assert.equal(scan.failures, 0);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.records[0]?.operation.operationId, active.operation.operationId);
  assert.equal((await readdir(root)).filter((name) => name.endsWith('.json')).length, 2);
  const replay = await store.claim(first);
  assert.equal(replay.state, 'REPLAY');
  assert.equal(replay.record.phase, 'COMPLETED');
  assert.equal((await store.claim(record(61, first.operation.operationId))).state, 'COLLISION');
});
