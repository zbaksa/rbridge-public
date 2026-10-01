import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {negotiateHello, validateEventEnvelope, RbridgeEventSpoolV1} from '../src/domain/rbridgeChatCore.js';
import * as Protocol from '../src/domain/rbridgeEffectProtocol.js';
let passed = 0;
const contractCase = async (name: string, fn: () => Promise<void>): Promise<void> => {await fn(); passed++; console.log('PASS '+name);};
type Wire = Record<string, unknown>;
const wire = (value: unknown): Wire => value as Wire;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const golden = wire(JSON.parse(readFileSync('tests/fixtures/rbridge-cocwin-contract-v3.json', 'utf8')));
const vectors = golden.vectors as Wire[];
interface ContractApi {
  parseEffectRequest(input: unknown, maxBytes: number): Promise<Wire>;
  parseEffectCommand(input: unknown, maxBytes: number): Promise<Wire>;
  parseEffectResult(input: unknown, command: unknown, maxBytes: number): Promise<Wire>;
  validateCaptureEventV3(input: unknown, maxBytes: number): Promise<Wire>;
  requireV3Peer(input: unknown): void;
}
const api = Protocol as unknown as ContractApi;
// This test signer is independent of the implementation. Golden hashes are fixed Python outputs.
function oracleJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(oracleJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const row = wire(value);
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + oracleJson(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function signed(value: Wire, field: string): Wire {
  const out = copy(value); delete out[field];
  out[field] = createHash('sha256').update(oracleJson(out)).digest('hex'); return out;
}
const requestOf = (index = 1): Wire => copy(wire(vectors[index]!.request));
const commandOf = (index = 1): Wire => copy(wire(vectors[index]!.command));
const resultOf = (index = 1): Wire => copy(wire(vectors[index]!.result));
const peer = () => ({peerId: 'peer-1', releaseSha: 'a'.repeat(40), browserInstanceId: 'chrome-main', browserProfileId: 'profile-main', protocolMinor: 1, maxMessageBytes: 65536, capabilities: ['CHAT_TARGET_DISCOVERY_V1', 'CHAT_BINDING_V1', 'CHAT_WRITE_LEADER_V1', 'CHAT_CAPTURE_V1', 'CHAT_SEND_TX_V1', 'CHAT_QUOTA_OBSERVATION_V1', 'CHAT_ROLLOVER_V1', 'REPLAY_SEQUENCE_V1', 'CHAT_EFFECT_REQUEST_V1', 'CHAT_ASSISTANT_TURN_CAPTURE_V2']});
const denied = async (action: () => Promise<unknown>) => {await assert.rejects(action);};

await contractCase('four independent golden request/command/full-receipt result vectors', async () => {
  for (const vector of vectors) {
    const req = await api.parseEffectRequest(vector.request, 65536);
    assert.deepEqual(req, vector.request);
    assert.equal(req.effectId, vector.expectedEffectId);
    assert.equal(req.requestDigest, vector.expectedRequestDigest);
    const command = await api.parseEffectCommand(vector.command, 65536);
    assert.equal(command.commandSha256, vector.expectedCommandSha256);
    const result = await api.parseEffectResult(vector.result, vector.command, 65536);
    assert.deepEqual(result, vector.result);
    assert.equal(result.resultSha256, vector.expectedResultSha256);
    assert.equal(wire(result.receipt).sha256, vector.expectedReceiptSha256);
  }
});
await contractCase('unknown and missing keys are denied at every authority boundary', async () => {
  for (const vector of vectors) {
    for (const path of [[], ['payload'], ['payload', 'target']]) {
      const original = wire(vector.request);
      let row = original; for (const key of path) row = wire(row[key]);
      for (const key of Object.keys(row)) {
        const candidate = copy(original); let target = candidate;
        for (const part of path) target = wire(target[part]); delete target[key];
        await denied(() => api.parseEffectRequest(path.length === 0 && key === 'requestDigest' ? candidate : signed(candidate, 'requestDigest'), 65536));
      }
      const candidate = copy(original); let target = candidate;
      for (const part of path) target = wire(target[part]); target.extra = true;
      await denied(() => api.parseEffectRequest(signed(candidate, 'requestDigest'), 65536));
    }
    const command = wire(vector.command);
    for (const key of Object.keys(command)) {
      const bad = copy(command); delete bad[key];
      // Do not re-add the deliberately absent digest.
      await denied(() => api.parseEffectCommand(key === 'commandSha256' ? bad : signed(bad, 'commandSha256'), 65536));
    }
    await denied(() => api.parseEffectCommand(signed({...command, extra: true}, 'commandSha256'), 65536));
    const result = wire(vector.result);
    for (const key of Object.keys(result)) {
      const bad = copy(result); delete bad[key];
      await denied(() => api.parseEffectResult(key === 'resultSha256' ? bad : signed(bad, 'resultSha256'), command, 65536));
    }
    const receipt = wire(result.receipt);
    for (const key of [...Object.keys(receipt), 'extra']) {
      const bad = copy(result); const inner = wire(bad.receipt);
      if (key === 'extra') inner.extra = true; else delete inner[key];
      bad.receipt = key === 'sha256' ? inner : signed(inner, 'sha256');
      await denied(() => api.parseEffectResult(signed(bad, 'resultSha256'), command, 65536));
    }
  }
});
await contractCase('digests and derived effect identity cannot be forged by rehashing outer wrappers', async () => {
  const req = requestOf(); req.effectId = 'f'.repeat(64);
  await denied(() => api.parseEffectRequest(signed(req, 'requestDigest'), 65536));
  const badRequest = requestOf(); wire(badRequest.payload).text = 'changed';
  await denied(() => api.parseEffectRequest(badRequest, 65536));
  const command = commandOf(); command.request = badRequest;
  await denied(() => api.parseEffectCommand(signed(command, 'commandSha256'), 65536));
  const result = resultOf(); wire(result.receipt).observedAt = '2026-10-01T05:01:00.000Z';
  await denied(() => api.parseEffectResult(signed(result, 'resultSha256'), commandOf(), 65536));
});
await contractCase('every result correlation field is checked after valid rehash', async () => {
  for (const key of ['commandId', 'commandSha256', 'sessionId', 'generation', 'attemptId', 'effectId', 'requestDigest']) {
    const bad = resultOf();
    bad[key] = key === 'sessionId' ? 'exta-' + '2'.repeat(32) : key === 'generation' ? '33333333-3333-4333-8333-333333333333' : key === 'attemptId' ? String(bad.attemptId).replace(':a:1', ':a:2') : key === 'commandId' ? 'other-command' : 'f'.repeat(64);
    await denied(() => api.parseEffectResult(signed(bad, 'resultSha256'), commandOf(), 65536));
  }
  for (const key of ['challenge', 'purpose', 'conversationId', 'conversationGeneration', 'sessionId', 'generation', 'attemptId', 'effectId']) {
    const bad = resultOf(); const receipt = wire(bad.receipt);
    receipt[key] = key === 'purpose' ? 'RESULT' : key === 'conversationGeneration' ? 2 : key === 'conversationId' ? 'other-conversation' : key === 'sessionId' ? 'exta-' + '2'.repeat(32) : key === 'generation' ? '33333333-3333-4333-8333-333333333333' : key === 'attemptId' ? String(receipt.attemptId).replace(':a:1', ':a:2') : 'f'.repeat(64);
    bad.receipt = signed(receipt, 'sha256');
    await denied(() => api.parseEffectResult(signed(bad, 'resultSha256'), commandOf(), 65536));
  }
});
await contractCase('binding and rollover verify exact browser/project/owner and successor scope', async () => {
  for (const index of [0, 3]) {
    for (const key of ['browserInstanceId', 'browserProfileId', 'windowId', 'tabId', 'origin', 'projectId', 'ownerSessionId', 'conversationGeneration', 'writeLeaderEpoch', 'captureEpoch']) {
      const bad = resultOf(index); const outer = wire(bad.receipt);
      const receipt = index === 3 ? wire(outer.bindingReceipt) : outer;
      receipt[key] = key === 'windowId' || key === 'tabId' ? 99 : key === 'conversationGeneration' ? 10 : key === 'writeLeaderEpoch' || key === 'captureEpoch' ? 0 : key === 'origin' ? 'https://example.org' : key === 'ownerSessionId' ? 'exta-' + '2'.repeat(32) : 'other';
      if (index === 3) {outer.bindingReceipt = signed(receipt, 'sha256'); bad.receipt = signed(outer, 'sha256');}
      else bad.receipt = signed(receipt, 'sha256');
      await denied(() => api.parseEffectResult(signed(bad, 'resultSha256'), commandOf(index), 65536));
    }
  }
  const same = resultOf(3); const rollover = wire(same.receipt);
  const binding = wire(rollover.bindingReceipt); binding.conversationId = rollover.previousConversationId;
  rollover.bindingReceipt = signed(binding, 'sha256'); same.receipt = signed(rollover, 'sha256');
  await denied(() => api.parseEffectResult(signed(same, 'resultSha256'), commandOf(3), 65536));
});
await contractCase('VERIFIED needs full evidence and negative states need a reason', async () => {
  for (const receipt of [null, {schema: 'COCWIN_RECEIPT_REF_V1', receiptId: 'reference', receiptSchema: 'RBRIDGE_CHAT_SEND_RECEIPT_V1', sha256: 'a'.repeat(64)}]) {
    await denied(() => api.parseEffectResult(signed({...resultOf(), receipt}, 'resultSha256'), commandOf(), 65536));
  }
  const negativeReceipt = resultOf(); wire(negativeReceipt.receipt).transactionState = 'UNCERTAIN';
  negativeReceipt.receipt = signed(wire(negativeReceipt.receipt), 'sha256');
  await denied(() => api.parseEffectResult(signed(negativeReceipt, 'resultSha256'), commandOf(), 65536));
  for (const state of ['FAILED_SAFE', 'BLOCKED', 'UNCERTAIN', 'APPLIED_UNVERIFIED']) {
    await denied(() => api.parseEffectResult(signed({...resultOf(), state, receipt: null}, 'resultSha256'), commandOf(), 65536));
    const negative = signed({...resultOf(), state, receipt: null, reason: 'OWNER_ACTION_REQUIRED'}, 'resultSha256');
    assert.deepEqual(await api.parseEffectResult(negative, commandOf(), 65536), negative);
  }
});
await contractCase('safe integer, target, attempt and payload variant boundaries fail closed', async () => {
  for (const ordinal of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const req = requestOf(); req.effectOrdinal = ordinal;
    await denied(() => api.parseEffectRequest(signed(req, 'requestDigest'), 65536));
  }
  for (const [key, value] of [['windowId', -1], ['tabId', 2147483648], ['conversationGeneration', 0], ['origin', 'https://chatgpt.com/'], ['canonicalProjectId', 'g-p-other'], ['projectId', 'g-p-' + 'b'.repeat(32)] ] as const) {
    const req = requestOf(); wire(wire(req.payload).target)[key] = value;
    await denied(() => api.parseEffectRequest(signed(req, 'requestDigest'), 65536));
  }
  for (const attempt of [String(requestOf().sessionId) + ':a:01', String(requestOf().sessionId) + ':a:9007199254740992']) {
    const req = requestOf(); req.attemptId = attempt;
    await denied(() => api.parseEffectRequest(signed(req, 'requestDigest'), 65536));
  }
  const mixed = requestOf(); wire(mixed.payload).purpose = 'RESULT';
  await denied(() => api.parseEffectRequest(signed(mixed, 'requestDigest'), 65536));
  const rollover = requestOf(3); wire(rollover.payload).nextConversationGeneration = 3;
  await denied(() => api.parseEffectRequest(signed(rollover, 'requestDigest'), 65536));
});
await contractCase('48000 byte text ceiling and complete escaped wrapper budgets', async () => {
  for (const [length, accepted] of [[48000, true], [48001, false]] as const) {
    const req = requestOf(); wire(req.payload).text = 'x'.repeat(length); const candidate = signed(req, 'requestDigest');
    if (accepted) await api.parseEffectRequest(candidate, 65536);
    else await denied(() => api.parseEffectRequest(candidate, 65536));
  }
  const req = requestOf(); wire(req.payload).text = 'x'.repeat(3300); const candidate = signed(req, 'requestDigest');
  const command = commandOf(); command.request = candidate; const wrapped = signed(command, 'commandSha256');
  const ceiling = Buffer.byteLength(JSON.stringify(candidate)); assert.ok(ceiling >= 4096);
  await api.parseEffectRequest(candidate, ceiling);
  await assert.rejects(() => api.parseEffectCommand(wrapped, ceiling), /OUTPUT_BUDGET_EXCEEDED/);
  for (const ceiling of [4095, 65537, NaN, 4096.5]) await denied(() => api.parseEffectRequest(requestOf(), ceiling));
});
await contractCase('capture preserves the full raw Markdown byte sequence', async () => {
  const event = await api.validateCaptureEventV3(golden.capturedEvent, 65536);
  assert.deepEqual(event, golden.capturedEvent);
  const payload = wire(event.payload); assert.equal(Buffer.byteLength(String(payload.assistantTurnUtf8)), golden.markdownUtf8Bytes);
  assert.match(String(payload.assistantTurnUtf8), /\r\n```json\r\n/);
  const bad = copy(wire(golden.capturedEvent)); wire(bad.payload).assistantTurnUtf8 = String(wire(bad.payload).assistantTurnUtf8).replaceAll('\r\n', '\n');
  await denied(() => api.validateCaptureEventV3(signed(bad, 'eventSha256'), 65536));
});
await contractCase('capture unknown fields, missing fields, digest, and envelope correlations are denied', async () => {
  const original = wire(golden.capturedEvent);
  for (const path of [[], ['payload'], ['payload', 'captureReceipt']]) {
    let source = original; for (const key of path) source = wire(source[key]);
    for (const key of [...Object.keys(source), 'extra']) {
      const bad = copy(original); let target = bad; for (const part of path) target = wire(target[part]);
      if (key === 'extra') target.extra = true; else delete target[key];
      if (path.length === 2 && key !== 'sha256') wire(bad.payload).captureReceipt = signed(target, 'sha256');
      await denied(() => api.validateCaptureEventV3(path.length === 0 && key === 'eventSha256' ? bad : signed(bad, 'eventSha256'), 65536));
    }
  }
  for (const key of ['sessionId', 'generation', 'attemptId', 'effectId']) {
    const bad = copy(original); bad[key] = key === 'sessionId' ? 'exta-' + '2'.repeat(32) : key === 'generation' ? '33333333-3333-4333-8333-333333333333' : key === 'attemptId' ? String(bad.attemptId).replace(':a:1', ':a:2') : 'f'.repeat(64);
    await denied(() => api.validateCaptureEventV3(signed(bad, 'eventSha256'), 65536));
  }
});
await contractCase('escaped full turn exceeds envelope limit and rejection stays within the 4096 floor', async () => {
  const escaped = wire(golden.escapedTurn);
  const full = {...wire(escaped.eventTemplate), payload: {captureReceipt: escaped.receipt, assistantTurnUtf8: String.fromCodePoint(Number(escaped.codePoint)).repeat(Number(escaped.repeat))}};
  assert.equal(Buffer.byteLength(JSON.stringify(full)), escaped.expectedCapturedBytes);
  await assert.rejects(() => api.validateCaptureEventV3(full, 65536), /OUTPUT_BUDGET_EXCEEDED/);
  assert.deepEqual(await api.validateCaptureEventV3(escaped.rejectionEvent, 4096), escaped.rejectionEvent);
  assert.equal(Buffer.byteLength(JSON.stringify(golden.maximumRejectedEvent)), golden.maximumRejectedBytes);
  await api.validateCaptureEventV3(golden.maximumRejectedEvent, 4096);
  await api.validateCaptureEventV3(golden.oversizeRejectedEvent, 4096);
  for (const event of [wire(escaped.rejectionEvent), wire(golden.oversizeRejectedEvent)]) {
    const bad = copy(event); wire(bad.payload).reason = wire(bad.payload).reason === 'OUTPUT_BUDGET_EXCEEDED' ? 'MACHINE_RESPONSE_TOO_LARGE' : 'OUTPUT_BUDGET_EXCEEDED';
    await denied(() => api.validateCaptureEventV3(signed(bad, 'eventSha256'), 4096));
  }
});
await contractCase('V3 requires every capability and cannot downgrade to old capture', async () => {
  api.requireV3Peer(peer());
  for (const capability of peer().capabilities) {
    const value = peer(); value.capabilities = value.capabilities.filter(x => x !== capability);
    assert.throws(() => api.requireV3Peer(value), /RBRIDGE_CAPABILITY_MISSING/);
  }
  assert.throws(() => api.requireV3Peer({...peer(), protocolMinor: 0}));
  assert.throws(() => api.requireV3Peer({...peer(), maxMessageBytes: 4095}), /OUTPUT_BUDGET_EXCEEDED/);
  const old = copy(wire(golden.capturedEvent)); old.eventType = 'RESPONSE_CAPTURED';
  await denied(() => api.validateCaptureEventV3(signed(old, 'eventSha256'), 65536));
});
await contractCase('validation snapshots inputs before any asynchronous digest and never invokes getters', async () => {
  const original = requestOf(); const expected = copy(original);
  const running = api.parseEffectRequest(original, 65536); wire(original.payload).text = 'mutation'; original.extra = true;
  assert.deepEqual(await running, expected);
  let invoked = 0; const getter = requestOf(); Object.defineProperty(getter, 'appId', {enumerable: true, get() {invoked++; return 'cocwin';}});
  await denied(() => api.parseEffectRequest(getter, 65536)); assert.equal(invoked, 0);
  const symbol = requestOf(); Object.defineProperty(symbol, Symbol('hidden'), {value: true});
  await denied(() => api.parseEffectRequest(symbol, 65536));
  const proto = Object.create(requestOf()) as Wire;
  await denied(() => api.parseEffectRequest(proto, 65536));
});

await contractCase('core negotiates only explicit minor-1 V3 capabilities and keeps minor-0 history', async () => {
  const hello = {schema: 'RBRIDGE_CHAT_HELLO_V1', protocolMajor: 1, protocolMinor: 1, releaseSha: 'a'.repeat(40), maxMessageBytes: 65536, capabilities: peer().capabilities, browserInstanceId: 'chrome-main', browserProfileId: 'profile-main', nativeHostVersion: 'test'};
  const both = negotiateHello(hello, hello); assert.deepEqual(both.capabilities, hello.capabilities);
  const old = negotiateHello(hello, {...hello, protocolMinor: 0});
  assert.equal(old.protocolMinor, 0); assert.deepEqual(old.capabilities, peer().capabilities.slice(0, 8));
  const one = negotiateHello(hello, {...hello, capabilities: hello.capabilities.filter(c => c !== 'CHAT_ASSISTANT_TURN_CAPTURE_V2')});
  assert.equal(one.capabilities.includes('CHAT_ASSISTANT_TURN_CAPTURE_V2'), false);
  assert.throws(() => api.requireV3Peer({...peer(), ...one}), /RBRIDGE_CAPABILITY_MISSING/);
});
await contractCase('core validates new capture, retains chain checks, and rejects tampered append/replay', async () => {
  const event = wire(golden.capturedEvent);
  assert.deepEqual(await validateEventEnvelope(event, null, 1), event);
  await assert.rejects(() => validateEventEnvelope(event, null, 2), /RBRIDGE_EVENT_SEQUENCE_GAP/);
  await assert.rejects(() => validateEventEnvelope(event, 'f'.repeat(64), 1), /RBRIDGE_EVENT_CHAIN_MISMATCH/);
  const spool = new RbridgeEventSpoolV1();
  const {schema: _schema, sequence: _sequence, previousEventSha256: _previous, eventSha256: _sha, ...input} = event;
  void _schema; void _sequence; void _previous; void _sha;
  const appended = await spool.append(input as unknown as Parameters<RbridgeEventSpoolV1['append']>[0]);
  assert.deepEqual(appended, event); assert.deepEqual(await spool.append(input as unknown as Parameters<RbridgeEventSpoolV1['append']>[0]), event);
  const tampered = copy(input); wire(tampered.payload).assistantTurnUtf8 = 'tampered';
  await assert.rejects(() => spool.append(tampered as unknown as Parameters<RbridgeEventSpoolV1['append']>[0]));
  const invalidNew = {...tampered, eventId: 'new-invalid'}; await assert.rejects(() => spool.append(invalidNew as unknown as Parameters<RbridgeEventSpoolV1['append']>[0]));
  assert.equal(spool.size, 1);
});
await contractCase('catalog field, capability and reason sets match the independent golden objects', async () => {
  const catalog = wire(JSON.parse(readFileSync('docs/topplan/COCWIN_BROWSER_FALLBACK_M0_SCHEMA_CATALOG_V3.json', 'utf8')));
  assert.equal(catalog['x-freeze-state'], 'FREEZE_PENDING_IMPLEMENTATION');
  assert.deepEqual(wire(catalog['x-protocol']).requiredCapabilities, peer().capabilities);
  const definitions = wire(catalog.$defs);
  const fields = (name: string, value: unknown) => {
    const definition = wire(definitions[name]); assert.equal(definition.additionalProperties, false);
    assert.deepEqual((definition.required as string[]).slice().sort(), Object.keys(wire(value)).sort());
    assert.deepEqual(Object.keys(wire(definition.properties)).sort(), Object.keys(wire(value)).sort());
  };
  for (const vector of vectors) {
    const request = wire(vector.request); fields(String(request.effectKind) + '_Request', request);
    fields('ExactBrowserTargetV1', wire(request.payload).target);
    const payload = wire(wire(wire(definitions[String(request.effectKind) + '_Request']).properties).payload);
    assert.deepEqual((payload.required as string[]).slice().sort(), Object.keys(wire(request.payload)).sort());
    fields('RbridgeChatEffectCommandV1', vector.command); fields('RbridgeChatEffectResultV1', vector.result);
    const receipt = wire(wire(vector.result).receipt);
    fields(receipt.schema === 'RBRIDGE_CHAT_BINDING_RECEIPT_V1' ? 'RbridgeChatBindingReceiptV1' : receipt.schema === 'RBRIDGE_CHAT_SEND_RECEIPT_V1' ? 'RbridgeChatSendReceiptV1' : 'RolloverReceiptV1', receipt);
    if (receipt.bindingReceipt) fields('RbridgeChatBindingReceiptV1', receipt.bindingReceipt);
  }
  fields('ASSISTANT_TURN_CAPTURED_V2', golden.capturedEvent);
  fields('ASSISTANT_TURN_REJECTED_V2', golden.maximumRejectedEvent);
  fields('RbridgeChatCaptureReceiptV2', wire(wire(golden.capturedEvent).payload).captureReceipt);
  for (const reason of ['MACHINE_RESPONSE_TOO_LARGE', 'OUTPUT_BUDGET_EXCEEDED', 'SEND_UNCERTAIN', 'EXTERNAL_AGENT_EFFECT_OUTCOME_UNCERTAIN', 'EXTERNAL_AGENT_RECONCILIATION_UNAVAILABLE', 'UI_PROTOCOL_CHANGED']) assert.ok((catalog['x-sharedReasonCodes'] as string[]).includes(reason));
});
await contractCase('maximum bounded IDs, UTF8 payloads, epochs and sequence remain precise', async () => {
  const command = commandOf(); command.commandId = 'x'.repeat(192);
  await api.parseEffectCommand(signed(command, 'commandSha256'), 65536);
  command.commandId = 'x'.repeat(193); await denied(() => api.parseEffectCommand(signed(command, 'commandSha256'), 65536));
  const req = requestOf(); wire(req.payload).text = 'Ž'.repeat(24000);
  await api.parseEffectRequest(signed(req, 'requestDigest'), 65536);
  wire(req.payload).text = 'Ž'.repeat(24001); await denied(() => api.parseEffectRequest(signed(req, 'requestDigest'), 65536));
  const event = copy(wire(golden.capturedEvent)); const receipt = wire(wire(event.payload).captureReceipt);
  receipt.receiptId = 'x'.repeat(256); receipt.assistantTurnId = 'y'.repeat(256);
  receipt.captureEpoch = Number.MAX_SAFE_INTEGER; event.sequence = Number.MAX_SAFE_INTEGER;
  wire(event.payload).captureReceipt = signed(receipt, 'sha256');
  await api.validateCaptureEventV3(signed(event, 'eventSha256'), 65536);
  for (const [key, value] of [['receiptId', 'x'.repeat(257)], ['assistantTurnId', 'y'.repeat(257)], ['captureEpoch', Number.MAX_SAFE_INTEGER + 1], ['responseUtf8Bytes', Number.MAX_SAFE_INTEGER + 1]] as const) {
    const bad = copy(event); const inner = wire(wire(bad.payload).captureReceipt); inner[key] = value;
    wire(bad.payload).captureReceipt = signed(inner, 'sha256'); await denied(() => api.validateCaptureEventV3(signed(bad, 'eventSha256'), 65536));
  }
  const badSequence = {...event, sequence: Number.MAX_SAFE_INTEGER + 1}; await denied(() => api.validateCaptureEventV3(signed(badSequence, 'eventSha256'), 65536));
  const noncanonical = requestOf(); noncanonical.sessionId = String(noncanonical.sessionId) + '\n';
  await denied(() => api.parseEffectRequest(signed(noncanonical, 'requestDigest'), 65536));
});

console.log('V3_CONTRACT_PASS '+passed);
