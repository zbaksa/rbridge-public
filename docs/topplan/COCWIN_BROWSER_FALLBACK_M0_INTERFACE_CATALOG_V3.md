# COCWIN Browser Fallback — M0 Interface Catalog V3

Status: **FREEZE_PENDING_IMPLEMENTATION**. Schema: `COCWIN_BROWSER_FALLBACK_M0_SCHEMA_CATALOG_V3.json`. Contract: `COCWIN_BROWSER_FALLBACK_M0_CONTRACT_V3.md`.

Exact required wire shapes and integration-only types follow. Unknown/missing fields are rejected. A VerifiedPeerV3 struct is constructed after authenticated, pinned major-1 HELLO; its shape does not authenticate a caller. Legacy historical V1 event payloads retain their existing catalog meanings. This catalog adds only the two V2 assistant-turn event payloads below.

```ts
export type BrowserEffectKind = 'RBRIDGE_BIND' | 'RBRIDGE_SEND' | 'RBRIDGE_RESULT_SEND' | 'RBRIDGE_ROLLOVER';
export interface V3Scope {appId: string; baseSha: string; sessionId: string; generation: string}
export interface ExactBrowserTargetV1 {
  browserInstanceId: string; browserProfileId: string; windowId: number; tabId: number;
  origin: 'https://chatgpt.com'; canonicalProjectId: string; projectId: string; conversationId: string; conversationGeneration: number;
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

ASSISTANT_TURN_CAPTURED_V2 = {captureReceipt: RbridgeChatCaptureReceiptV2; assistantTurnUtf8: string};
ASSISTANT_TURN_REJECTED_V2 = {captureReceipt: RbridgeChatCaptureReceiptV2; reason: 'MACHINE_RESPONSE_TOO_LARGE' | 'OUTPUT_BUDGET_EXCEEDED'};
```

All counters use safe integers. ExactBrowserTarget window/tab are 0..2147483647; conversation generation is 1..2147483647. Request/result and receipt correlation, digests, byte limits, capabilities and stable reason rules in the contract and schema are mandatory. Event sequence/previous digest are retained across upgrades; downstream ingress validates stream continuity and active request/capture scope before W3.

Public validators: parseEffectRequest(input:unknown,maxBytes:number); parseEffectCommand(input:unknown,maxBytes:number); parseEffectResult(input:unknown,command:RbridgeChatEffectCommandV1,maxBytes:number); validateCaptureEventV3(input:unknown,maxBytes:number), each returning a Promise of its exact object type. requireV3Peer(peer:VerifiedPeerV3):void enforces minor/capabilities/ceiling after authentication.
