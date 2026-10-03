import assert from 'node:assert/strict';
import {it} from 'vitest';
import { runFlowPilotBridgeTick } from '../../src/server/flowPilotBridgeTick.js';

it('primary and FlowPilot reconciliation run independently', async () => {
  const events: string[] = [];
  const result = await runFlowPilotBridgeTick({
    async runPrimary() { events.push('primary'); return { pending: 0 }; },
    async reconcile() { events.push('flowpilot'); return { completed: 1 }; },
    log(value) { events.push(String(value.status)); },
  });
  assert.deepEqual(result, { pending: 0 });
  assert.deepEqual(events.sort(), ['flowpilot', 'primary']);
});

it('FlowPilot failure is redacted and never blocks the primary bridge tick', async () => {
  const secret = 's'.repeat(40); const logs: Record<string, unknown>[] = [];
  const result = await runFlowPilotBridgeTick({
    async runPrimary() { return 'PRIMARY_PASS'; },
    async reconcile() { throw new Error(`socket Authorization: Bearer ${secret}`); },
    log(value) { logs.push(value); },
    now: () => new Date('2026-09-28T19:00:00.000Z'),
  });
  assert.equal(result, 'PRIMARY_PASS');
  assert.deepEqual(logs, [{ schema: 'COCWIN_FLOWPILOT_BRIDGE_RECONCILE_V1', status: 'ERROR', at: '2026-09-28T19:00:00.000Z', reason: 'FLOWPILOT_BRIDGE_RECONCILE_FAILED' }]);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});

it('only enumerated-style FlowPilot error codes may reach logs', async () => {
  const logs: Record<string, unknown>[] = [];
  await runFlowPilotBridgeTick({
    async runPrimary() { return 'PRIMARY_PASS'; },
    async reconcile() { throw new Error('FLOWPILOT_CALLBACK_REJECTED:409'); },
    log(value) { logs.push(value); },
  });
  assert.equal(logs[0]?.reason, 'FLOWPILOT_CALLBACK_REJECTED:409');
});

it('primary failure still waits for FlowPilot reconciliation before propagating', async () => {
  let reconciled = false;
  await assert.rejects(runFlowPilotBridgeTick({
    async runPrimary() { throw new Error('PRIMARY_FAILED'); },
    async reconcile() { reconciled = true; },
    log() {},
  }), /PRIMARY_FAILED/);
  assert.equal(reconciled, true);
});
