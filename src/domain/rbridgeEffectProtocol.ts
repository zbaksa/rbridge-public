type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export function canonicalJson(value: unknown): string {
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error('RBRIDGE_CANONICAL_JSON_NUMBER_INVALID');
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const out: Record<string, JsonValue> = {};
      const keys = Object.keys(row).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
      for (const key of keys) {
        if (!/^[\x20-\x7e]+$/u.test(key)) throw new Error('RBRIDGE_CANONICAL_JSON_KEY_INVALID');
        out[key] = visit(row[key]);
      }
      return out;
    }
    throw new Error('RBRIDGE_CANONICAL_JSON_VALUE_INVALID');
  };
  return JSON.stringify(visit(value));
}
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
}
export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

// V3 wire validation is separate from peer authentication and browser execution.
export const V3_CAPABILITIES = Object.freeze([
  'CHAT_TARGET_DISCOVERY_V1', 'CHAT_BINDING_V1', 'CHAT_WRITE_LEADER_V1', 'CHAT_CAPTURE_V1',
  'CHAT_SEND_TX_V1', 'CHAT_QUOTA_OBSERVATION_V1', 'CHAT_ROLLOVER_V1', 'REPLAY_SEQUENCE_V1',
  'CHAT_EFFECT_REQUEST_V1', 'CHAT_ASSISTANT_TURN_CAPTURE_V2',
] as const);
export type BrowserEffectKind = 'RBRIDGE_BIND' | 'RBRIDGE_SEND' | 'RBRIDGE_RESULT_SEND' | 'RBRIDGE_ROLLOVER';
export interface V3Scope {appId: string; baseSha: string; sessionId: string; generation: string}
export interface ExactBrowserTargetV1 {
  browserInstanceId: string; browserProfileId: string; windowId: number; tabId: number;
  origin: string; canonicalProjectId: string; projectId: string; conversationId: string; conversationGeneration: number;
}
interface RequestBase extends V3Scope {
  schema: 'COCWIN_RBRIDGE_EFFECT_REQUEST_V1'; attemptId: string; effectId: string;
  effectOrdinal: number; createdAt: string; requestDigest: string;
}
export type CocwinRbridgeEffectRequestV1 = RequestBase & (
  | {effectKind: 'RBRIDGE_BIND'; payload: {target: ExactBrowserTargetV1}}
  | {effectKind: 'RBRIDGE_SEND'; payload: {target: ExactBrowserTargetV1; challenge: string; purpose: 'PROMPT'; text: string}}
  | {effectKind: 'RBRIDGE_RESULT_SEND'; payload: {target: ExactBrowserTargetV1; challenge: string; purpose: 'RESULT'; text: string}}
  | {effectKind: 'RBRIDGE_ROLLOVER'; payload: {target: ExactBrowserTargetV1; nextConversationGeneration: number}}
);
export type BrowserEffectPayloadV1 = CocwinRbridgeEffectRequestV1['payload'];
export interface RbridgeChatEffectCommandV1 {
  schema: 'RBRIDGE_CHAT_EFFECT_COMMAND_V1'; commandId: string; action: 'EXECUTE' | 'RECONCILE';
  issuedAt: string; request: CocwinRbridgeEffectRequestV1; commandSha256: string;
}
export interface BindingReceiptV1 {
  schema: 'RBRIDGE_CHAT_BINDING_RECEIPT_V1'; receiptId: string; sessionId: string; generation: string;
  browserInstanceId: string; browserProfileId: string; windowId: number; tabId: number; origin: string;
  projectId: string; conversationId: string; conversationGeneration: number; ownerSessionId: string;
  writeLeaderEpoch: number; captureEpoch: number; observedAt: string; sha256: string;
}
export interface SendReceiptV1 {
  schema: 'RBRIDGE_CHAT_SEND_RECEIPT_V1'; receiptId: string; sessionId: string; generation: string;
  attemptId: string; effectId: string; challenge: string; purpose: 'PROMPT' | 'RESULT';
  transactionState: 'FAILED_BEFORE_CLICK' | 'UNCERTAIN' | 'SENT_VERIFIED' | 'STOPPED' | 'SUPERSEDED';
  conversationId: string; conversationGeneration: number; writeLeaderEpoch: number; observedAt: string; sha256: string;
}
export interface RolloverReceiptV1 {
  schema: 'RBRIDGE_CHAT_ROLLOVER_RECEIPT_V1'; receiptId: string; sessionId: string; generation: string;
  attemptId: string; effectId: string; requestDigest: string; previousConversationId: string;
  previousConversationGeneration: number; bindingReceipt: BindingReceiptV1; observedAt: string; sha256: string;
}
export interface RbridgeChatCaptureReceiptV2 {
  schema: 'RBRIDGE_CHAT_CAPTURE_RECEIPT_V2'; receiptId: string; sessionId: string; generation: string;
  attemptId: string; effectId: string; challenge: string; conversationId: string; conversationGeneration: number;
  assistantTurnId: string; captureEncoding: 'SITE_ASSISTANT_MARKDOWN_V1'; responseUtf8Bytes: number;
  assistantTurnSha256: string; captureEpoch: number; observedAt: string; sha256: string;
}
export type RbridgeChatBindingReceiptV1 = BindingReceiptV1;
export type RbridgeChatSendReceiptV1 = SendReceiptV1;
export type V3Receipt = BindingReceiptV1 | SendReceiptV1 | RolloverReceiptV1 | RbridgeChatCaptureReceiptV2;
export interface RbridgeChatEffectResultV1 {
  schema: 'RBRIDGE_CHAT_EFFECT_RESULT_V1'; commandId: string; commandSha256: string; sessionId: string;
  generation: string; attemptId: string; effectId: string; requestDigest: string; completedAt: string;
  state: 'VERIFIED' | 'FAILED_SAFE' | 'BLOCKED' | 'UNCERTAIN' | 'APPLIED_UNVERIFIED';
  receipt: BindingReceiptV1 | SendReceiptV1 | RolloverReceiptV1 | null; reason: string | null; resultSha256: string;
}
export interface RbridgeChatEventV1 {
  schema: 'RBRIDGE_CHAT_EVENT_V1'; eventId: string; sequence: number; previousEventSha256: string | null;
  eventType: string; sessionId: string; generation: string; attemptId: string | null; effectId: string | null;
  observedAt: string; payload: {[key: string]: JsonValue}; eventSha256: string;
}
export interface VerifiedPeerV3 {
  peerId: string; releaseSha: string; browserInstanceId: string; browserProfileId: string;
  protocolMinor: number; maxMessageBytes: number; capabilities: string[];
}
export interface ExpectedCaptureV3 {
  request: CocwinRbridgeEffectRequestV1; conversationId: string; conversationGeneration: number; captureEpoch: number;
}
export type EffectExecutionV3 = Pick<RbridgeChatEffectResultV1, 'state' | 'receipt' | 'reason'>;

type Row = Record<string, unknown>;
const v3Encoder = new TextEncoder();
const SAFE = Number.MAX_SAFE_INTEGER;
const TARGET_MAX = 2147483647;
const SESSION = /^exta-[0-9a-f]{32}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX256 = /^[0-9a-f]{64}$/;
const HEX160 = /^[0-9a-f]{40}$/;
const ASCII_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REASON = /^[A-Z][A-Z0-9_:-]{0,127}$/;
function invalid(code = 'RBRIDGE_V3_FIELDS_INVALID'): never {throw new Error(code);}
function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Row;
}
// Snapshot plain JSON values synchronously. Never execute toJSON/getters or retain input references across awaits.
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 8) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {if (!Number.isSafeInteger(value)) invalid(); return value;}
  if (typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const keys = Reflect.ownKeys(value); if (keys.length > 64) invalid();
  const out: Row = Object.create(null) as Row;
  for (const key of keys) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    out[key] = snapshot(descriptor.value, depth + 1);
  }
  // A normal object is returned; defineProperty avoids __proto__ mutation before strict-key rejection.
  return Object.fromEntries(Object.entries(out));
}
function exact(row: Row, keys: readonly string[]): void {
  const actual = Object.keys(row); if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
}
function schema(row: Row, name: string): void {if (row.schema !== name) invalid('RBRIDGE_V3_SCHEMA_INVALID');}
function str(value: unknown, re: RegExp, code = 'RBRIDGE_V3_SCALAR_INVALID'): string {
  if (typeof value !== 'string' || re.exec(value)?.[0] !== value) invalid(code); return value;
}
function integer(value: unknown, min = 0, max = SAFE): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid('RBRIDGE_V3_INTEGER_INVALID'); return value;
}
function identity(value: unknown, max: number, ascii = false): string {
  if (typeof value !== 'string' || !value || v3Encoder.encode(value).length > max || /[\u0000-\u001f\u007f]/u.test(value) || (ascii && !ASCII_ID.test(value))) invalid('RBRIDGE_V3_ID_INVALID'); return value;
}
function iso(value: unknown): string {
  if (typeof value !== 'string') invalid('RBRIDGE_TIMESTAMP_INVALID'); const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) invalid('RBRIDGE_TIMESTAMP_INVALID'); return value;
}
function scoped(row: Row, attempt = true): void {
  const session = str(row.sessionId, SESSION); str(row.generation, GENERATION);
  if (attempt) {
    const id = identity(row.attemptId, 256, true), prefix = session + ':a:';
    if (!id.startsWith(prefix) || !/^[1-9][0-9]*$/.test(id.slice(prefix.length))) invalid('RBRIDGE_ATTEMPT_ID_INVALID');
    integer(Number(id.slice(prefix.length)), 1); str(row.effectId, HEX256);
  }
}
function ceiling(value: number): number {
  if (!Number.isSafeInteger(value) || value < 4096 || value > 65536) invalid('OUTPUT_BUDGET_EXCEEDED'); return value;
}
function fits(value: unknown, max: number): void {
  if (v3Encoder.encode(JSON.stringify(value)).length > ceiling(max)) invalid('OUTPUT_BUDGET_EXCEEDED');
}
async function digest(row: Row, field: string): Promise<void> {
  const expected = str(row[field], HEX256, 'RBRIDGE_V3_DIGEST_INVALID');
  const body = {...row}; delete body[field];
  if (await canonicalDigest(body) !== expected) invalid('RBRIDGE_V3_DIGEST_MISMATCH');
}
function equal(actual: unknown, expected: unknown): void {if (actual !== expected) invalid('AGENT_RESPONSE_CORRELATION_MISMATCH');}
// Exact component semantics of the existing ChatGPT project parser, including its inherited fallback.
function projectComponent(raw: string): string {
  const value = raw.trim(); if (!value.startsWith('g-p-')) return '';
  return /^(g-p-[A-Za-z0-9]{32})(?:-[A-Za-z0-9][A-Za-z0-9-]*)?$/.exec(value)?.[1] ?? value;
}
function target(value: unknown): void {
  const row = object(value);
  exact(row, ['browserInstanceId', 'browserProfileId', 'windowId', 'tabId', 'origin', 'canonicalProjectId', 'projectId', 'conversationId', 'conversationGeneration']);
  identity(row.browserInstanceId, 128); identity(row.browserProfileId, 128);
  integer(row.windowId, 0, TARGET_MAX); integer(row.tabId, 0, TARGET_MAX);
  equal(row.origin, 'https://chatgpt.com');
  const canonical = identity(row.canonicalProjectId, 256), full = identity(row.projectId, 256);
  if (!projectComponent(full) || projectComponent(canonical) !== canonical || projectComponent(full) !== canonical) invalid('RBRIDGE_PROJECT_ID_INVALID');
  identity(row.conversationId, 256); integer(row.conversationGeneration, 1, TARGET_MAX);
}
export async function parseEffectRequest(input: unknown, maxBytes: number): Promise<CocwinRbridgeEffectRequestV1> {
  ceiling(maxBytes); const row = object(snapshot(input));
  exact(row, ['schema', 'appId', 'baseSha', 'sessionId', 'generation', 'attemptId', 'effectId', 'effectKind', 'effectOrdinal', 'createdAt', 'payload', 'requestDigest']);
  schema(row, 'COCWIN_RBRIDGE_EFFECT_REQUEST_V1'); scoped(row);
  str(row.appId, /^[a-z0-9][a-z0-9._-]{0,95}$/); str(row.baseSha, HEX160); iso(row.createdAt);
  const ordinal = integer(row.effectOrdinal, 1), payload = object(row.payload); target(payload.target);
  switch (row.effectKind) {
    case 'RBRIDGE_BIND': exact(payload, ['target']); break;
    case 'RBRIDGE_SEND':
    case 'RBRIDGE_RESULT_SEND':
      exact(payload, ['target', 'challenge', 'purpose', 'text']); str(payload.challenge, HEX256);
      equal(payload.purpose, row.effectKind === 'RBRIDGE_SEND' ? 'PROMPT' : 'RESULT');
      if (typeof payload.text !== 'string' || !payload.text || payload.text.includes('\0') || v3Encoder.encode(payload.text).length > 48000) invalid('RBRIDGE_V3_TEXT_INVALID');
      break;
    case 'RBRIDGE_ROLLOVER':
      exact(payload, ['target', 'nextConversationGeneration']);
      equal(integer(payload.nextConversationGeneration, 1, TARGET_MAX), Number(object(payload.target).conversationGeneration) + 1); break;
    default: invalid('RBRIDGE_V3_EFFECT_KIND_INVALID');
  }
  fits(row, maxBytes);
  equal(row.effectId, await sha256Hex([row.sessionId, row.generation, row.attemptId, row.effectKind, String(ordinal)].join('\0')));
  await digest(row, 'requestDigest'); return row as unknown as CocwinRbridgeEffectRequestV1;
}
export async function parseEffectCommand(input: unknown, maxBytes: number): Promise<RbridgeChatEffectCommandV1> {
  ceiling(maxBytes); const row = object(snapshot(input));
  exact(row, ['schema', 'commandId', 'action', 'issuedAt', 'request', 'commandSha256']); schema(row, 'RBRIDGE_CHAT_EFFECT_COMMAND_V1');
  identity(row.commandId, 192, true); if (row.action !== 'EXECUTE' && row.action !== 'RECONCILE') invalid(); iso(row.issuedAt);
  fits(row, maxBytes); row.request = await parseEffectRequest(row.request, maxBytes); await digest(row, 'commandSha256');
  return row as unknown as RbridgeChatEffectCommandV1;
}
async function binding(value: unknown): Promise<BindingReceiptV1> {
  const row = object(value);
  exact(row, ['schema', 'receiptId', 'sessionId', 'generation', 'browserInstanceId', 'browserProfileId', 'windowId', 'tabId', 'origin', 'projectId', 'conversationId', 'conversationGeneration', 'ownerSessionId', 'writeLeaderEpoch', 'captureEpoch', 'observedAt', 'sha256']);
  schema(row, 'RBRIDGE_CHAT_BINDING_RECEIPT_V1'); scoped(row, false); identity(row.receiptId, 512);
  identity(row.browserInstanceId, 128); identity(row.browserProfileId, 128); integer(row.windowId, 0, TARGET_MAX); integer(row.tabId, 0, TARGET_MAX);
  equal(row.origin, 'https://chatgpt.com'); identity(row.projectId, 256); identity(row.conversationId, 256); integer(row.conversationGeneration, 1, TARGET_MAX);
  str(row.ownerSessionId, SESSION); integer(row.writeLeaderEpoch); integer(row.captureEpoch); iso(row.observedAt);
  await digest(row, 'sha256'); return row as unknown as BindingReceiptV1;
}
function matchBinding(receipt: BindingReceiptV1, request: CocwinRbridgeEffectRequestV1, rollover = false): void {
  const t = request.payload.target;
  for (const key of ['browserInstanceId', 'browserProfileId', 'windowId', 'tabId', 'origin', 'projectId'] as const) equal(receipt[key], t[key]);
  equal(receipt.sessionId, request.sessionId); equal(receipt.generation, request.generation); equal(receipt.ownerSessionId, request.sessionId);
  integer(receipt.writeLeaderEpoch, 1); integer(receipt.captureEpoch, 1);
  if (rollover) {
    if (request.effectKind !== 'RBRIDGE_ROLLOVER') invalid();
    equal(receipt.conversationGeneration, request.payload.nextConversationGeneration);
    if (receipt.conversationId === t.conversationId) invalid('RBRIDGE_ROLLOVER_CONVERSATION_INVALID');
  } else {equal(receipt.conversationId, t.conversationId); equal(receipt.conversationGeneration, t.conversationGeneration);}
}
async function send(value: unknown, request: CocwinRbridgeEffectRequestV1, verified: boolean): Promise<SendReceiptV1> {
  const row = object(value);
  exact(row, ['schema', 'receiptId', 'sessionId', 'generation', 'attemptId', 'effectId', 'challenge', 'purpose', 'transactionState', 'conversationId', 'conversationGeneration', 'writeLeaderEpoch', 'observedAt', 'sha256']);
  schema(row, 'RBRIDGE_CHAT_SEND_RECEIPT_V1'); scoped(row); identity(row.receiptId, 512); iso(row.observedAt);
  if (request.effectKind !== 'RBRIDGE_SEND' && request.effectKind !== 'RBRIDGE_RESULT_SEND') invalid();
  for (const key of ['sessionId', 'generation', 'attemptId', 'effectId'] as const) equal(row[key], request[key]);
  equal(row.challenge, request.payload.challenge); equal(row.purpose, request.payload.purpose);
  equal(row.conversationId, request.payload.target.conversationId); equal(row.conversationGeneration, request.payload.target.conversationGeneration);
  integer(row.writeLeaderEpoch, verified ? 1 : 0);
  if (!['FAILED_BEFORE_CLICK', 'UNCERTAIN', 'SENT_VERIFIED', 'STOPPED', 'SUPERSEDED'].includes(String(row.transactionState))) invalid();
  if (verified) equal(row.transactionState, 'SENT_VERIFIED');
  else if (row.transactionState === 'SENT_VERIFIED') invalid();
  await digest(row, 'sha256'); return row as unknown as SendReceiptV1;
}
async function rollover(value: unknown, request: CocwinRbridgeEffectRequestV1): Promise<RolloverReceiptV1> {
  const row = object(value);
  exact(row, ['schema', 'receiptId', 'sessionId', 'generation', 'attemptId', 'effectId', 'requestDigest', 'previousConversationId', 'previousConversationGeneration', 'bindingReceipt', 'observedAt', 'sha256']);
  schema(row, 'RBRIDGE_CHAT_ROLLOVER_RECEIPT_V1'); scoped(row); identity(row.receiptId, 512); iso(row.observedAt);
  for (const key of ['sessionId', 'generation', 'attemptId', 'effectId', 'requestDigest'] as const) equal(row[key], request[key]);
  equal(row.previousConversationId, request.payload.target.conversationId); equal(row.previousConversationGeneration, request.payload.target.conversationGeneration);
  const receipt = await binding(row.bindingReceipt); matchBinding(receipt, request, true); row.bindingReceipt = receipt;
  await digest(row, 'sha256'); return row as unknown as RolloverReceiptV1;
}
export async function parseEffectResult(input: unknown, command: RbridgeChatEffectCommandV1, maxBytes: number): Promise<RbridgeChatEffectResultV1> {
  ceiling(maxBytes); const row = object(snapshot(input)), commandSnapshot = snapshot(command);
  exact(row, ['schema', 'commandId', 'commandSha256', 'sessionId', 'generation', 'attemptId', 'effectId', 'requestDigest', 'completedAt', 'state', 'receipt', 'reason', 'resultSha256']);
  schema(row, 'RBRIDGE_CHAT_EFFECT_RESULT_V1'); scoped(row); iso(row.completedAt); fits(row, maxBytes);
  const validated = await parseEffectCommand(commandSnapshot, maxBytes), request = validated.request;
  equal(row.commandId, validated.commandId); equal(row.commandSha256, validated.commandSha256);
  for (const key of ['sessionId', 'generation', 'attemptId', 'effectId', 'requestDigest'] as const) equal(row[key], request[key]);
  if (!['VERIFIED', 'FAILED_SAFE', 'BLOCKED', 'UNCERTAIN', 'APPLIED_UNVERIFIED'].includes(String(row.state))) invalid();
  if (row.state === 'VERIFIED') {
    equal(row.reason, null); if (row.receipt === null) invalid('RBRIDGE_V3_FULL_RECEIPT_REQUIRED');
    if (request.effectKind === 'RBRIDGE_BIND') {const receipt = await binding(row.receipt); matchBinding(receipt, request); row.receipt = receipt;}
    else if (request.effectKind === 'RBRIDGE_ROLLOVER') row.receipt = await rollover(row.receipt, request);
    else row.receipt = await send(row.receipt, request, true);
  } else {str(row.reason, REASON); if (row.receipt !== null) row.receipt = await send(row.receipt, request, false);}
  await digest(row, 'resultSha256'); return row as unknown as RbridgeChatEffectResultV1;
}
async function capture(value: unknown): Promise<RbridgeChatCaptureReceiptV2> {
  const row = object(value);
  exact(row, ['schema', 'receiptId', 'sessionId', 'generation', 'attemptId', 'effectId', 'challenge', 'conversationId', 'conversationGeneration', 'assistantTurnId', 'captureEncoding', 'responseUtf8Bytes', 'assistantTurnSha256', 'captureEpoch', 'observedAt', 'sha256']);
  schema(row, 'RBRIDGE_CHAT_CAPTURE_RECEIPT_V2'); scoped(row); identity(row.receiptId, 256, true); str(row.challenge, HEX256);
  identity(row.conversationId, 256); integer(row.conversationGeneration, 1, TARGET_MAX); identity(row.assistantTurnId, 256, true);
  equal(row.captureEncoding, 'SITE_ASSISTANT_MARKDOWN_V1'); integer(row.responseUtf8Bytes); str(row.assistantTurnSha256, HEX256);
  integer(row.captureEpoch, 1); iso(row.observedAt); await digest(row, 'sha256'); return row as unknown as RbridgeChatCaptureReceiptV2;
}
export async function validateCaptureEventV3(input: unknown, maxBytes: number): Promise<RbridgeChatEventV1> {
  ceiling(maxBytes); const row = object(snapshot(input));
  exact(row, ['schema', 'eventId', 'sequence', 'previousEventSha256', 'eventType', 'sessionId', 'generation', 'attemptId', 'effectId', 'observedAt', 'payload', 'eventSha256']);
  schema(row, 'RBRIDGE_CHAT_EVENT_V1'); scoped(row); identity(row.eventId, 192, true); integer(row.sequence, 1); iso(row.observedAt);
  if (row.previousEventSha256 !== null) str(row.previousEventSha256, HEX256);
  const payload = object(row.payload);
  if (row.eventType === 'ASSISTANT_TURN_CAPTURED_V2') {
    exact(payload, ['captureReceipt', 'assistantTurnUtf8']);
    if (typeof payload.assistantTurnUtf8 !== 'string') invalid();
    if (v3Encoder.encode(payload.assistantTurnUtf8).length > 16384) invalid('MACHINE_RESPONSE_TOO_LARGE');
  } else if (row.eventType === 'ASSISTANT_TURN_REJECTED_V2') exact(payload, ['captureReceipt', 'reason']);
  else invalid('RBRIDGE_EVENT_TYPE_INVALID');
  fits(row, maxBytes); const receipt = await capture(payload.captureReceipt);
  for (const key of ['sessionId', 'generation', 'attemptId', 'effectId'] as const) equal(row[key], receipt[key]);
  if (row.eventType === 'ASSISTANT_TURN_CAPTURED_V2') {
    const text = payload.assistantTurnUtf8 as string;
    equal(receipt.responseUtf8Bytes, v3Encoder.encode(text).length); equal(receipt.assistantTurnSha256, await sha256Hex(text));
  } else equal(payload.reason, receipt.responseUtf8Bytes > 16384 ? 'MACHINE_RESPONSE_TOO_LARGE' : 'OUTPUT_BUDGET_EXCEEDED');
  payload.captureReceipt = receipt; await digest(row, 'eventSha256'); return row as unknown as RbridgeChatEventV1;
}
export function requireV3Peer(peer: VerifiedPeerV3): void {
  // Call only after the fixed transport authenticated protocol-major 1 and pinned this peer/release.
  if (!peer || typeof peer !== 'object') invalid();
  identity(peer.peerId, 192, true); str(peer.releaseSha, HEX160); identity(peer.browserInstanceId, 128); identity(peer.browserProfileId, 128);
  integer(peer.protocolMinor, 1, 65535); ceiling(peer.maxMessageBytes);
  if (!Array.isArray(peer.capabilities) || peer.capabilities.length > 64 || new Set(peer.capabilities).size !== peer.capabilities.length || peer.capabilities.some(value => typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) || V3_CAPABILITIES.some(capability => !peer.capabilities.includes(capability))) invalid('RBRIDGE_CAPABILITY_MISSING');
}
