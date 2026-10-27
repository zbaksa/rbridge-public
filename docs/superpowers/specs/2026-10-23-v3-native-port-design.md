# Existing V3 Native Port routing

Purpose: close the missing V3 receive/result boundary in the existing extension
Native Port link, using the already shared effect schemas. The released worker
currently advertises minor0 and must retain its legacy behavior until separately
qualified composition and authorized activation.

Approach: extend ExtensionNativePortLinkV1 with an optional V3 effect-command hook
and a correlated asynchronous result sender. Reuse the existing V3 parser,
snapshot, byte-budget, digest and receipt validators. This avoids inventing a wire
message, translating away V3 evidence, or duplicating the browser executor.
Legacy V1 mutation fallback is incompatible with the existing V3 authority.

Contract:
- onServerEffectCommand(command:RbridgeChatEffectCommandV1):void|Promise<void>
  is optional; absent handler rejects V3 input.
- sendEffectResult(command:RbridgeChatEffectCommandV1,result:unknown):Promise<void>
  accepts the original command object supplied to the hook, validates its full
  correlation/receipt, and posts only in that command's original admission epoch.
- V3 delivery requires negotiated minor>=1 and every existing V3 capability.
  Negotiation is not peer authentication; Native Host private pin/scope and
  effect-store authority remain required outside this transport layer.
- Preserve current V1 command restrictions, sticky downgrade refusal and exact
  V1 startup. Do not modify serviceWorkerEntry, bootstrap storage or host config.
- Snapshot V3 input synchronously and enforce the negotiated message ceiling.
- Serialize V3 validation/callback admission in arrival order, while allowing
  later validation/RECONCILE and V1 reads during an unresolved browser callback.
- Bound retained V3 validation work at128 messages. Exhaustion fails closed.
- Disconnect, reconnect, a new HELLO or a protocol error fences old asynchronous
  validation/results. A stale failure must not clear a newer negotiation.

Acceptance: regression-first local transport tests, existing full repository
checks under the actual RBridge app identity/Node22 when admitted, fresh review,
then a source-only draft candidate. Local Node24 transformed-source tests are
supplemental and do not replace canonical typecheck/build/CI.

No new UI, protocol, credentials, root action, browser SEND or production
activation. COCWIN B1 composition, authenticated deployment and actual Windows
BIND/SEND/receipt/STOP remain separate acceptance boundaries.
