# Native scope quiescence transport implementation plan

**Goal:** Carry authenticated scope queries to the worker and correlated observations back through Native, without granting PASS.

**Files:** Modify nativeHostProtocol.ts, nativeHostRelay.ts, nativeHostRuntime.ts and server/rbridgeChatEventStore.ts only; add tests/w1-v3-native-quiescence.test.ts. Shared domain/package/browser/Linux CLI are other tasks.

**Contract:** Consume frozen rbridgeScopeQuiescence.ts query/worker/native report parsers and builders. Internal discriminants SCOPE_QUIESCENCE_QUERY and WORKER_QUIESCENCE_REPORT never appear on raw wire. Require negotiated optional capability and configured private peer pins. Bind bounded immutable pending records to actual Native epoch, exact query ID/nonce/request digest/query SHA; preserve originals while disconnect invalidates their authority. Never reserve an effect or grant a quiescence status.

**Observations:** Serialize worker report behind all earlier browser messages. Normalize existing readScopeInventory result to generic shared inventory, including null reservations. readDurableHead():Promise<{sequence:number;eventSha256:string|null}> takes append queue and independently reloads/validates full disk chain; cached events are not proof. Send native report only while same current protocol/epoch remains valid.

- [ ] Wait shared contract GREEN, then write real-private-store framing/router/relay tests.
- [ ] Actual RAppUID1027 RED under qualification flock for unsupported new control/report and absent durable-head accessor; no TypeScript-failure substitute.
- [ ] Implement strict V3-only routes, correlation, bounded pending controls, serial Native observations, durable head accessor and Runtime private pins wiring.
- [ ] Actual targeted GREEN, existing native transport/runtime suites, typecheck/build/touched lint/diff check. Parent coordinates full qualification.
- [ ] Export exact owned files/diff/hash manifest for independent review; no commit/push/activation.

**Negative cases:** Unsupported capability/config, unsolicited/mismatched/expired report, changed query ID bytes, stale epoch/disconnect during validation/readback/send, null reservations, invalid cached-vs-disk event chain, pending-map bound and unchanged effect/history bytes.

## Final output fences

Query admission and worker report validation are asynchronous. Native Runtime now repeats a synchronous exact-pending-query, private epoch/negotiated identity, configured scope/pins and deadline check immediately before native framing. Fresh and cached Native reports repeat the same synchronous check immediately before transport send; no await occurs after the check and before output begins. Reports retain original bytes when send completion becomes uncertain. Focused race regressions cover connection and expiry changes after asynchronous validation for queries and fresh/cached reports. The event head revalidates the complete durable disk chain through the append gate; this preserves history and follows the existing metadata initialization convention, without a filesystem zero-write claim. Source fixtures are qualification only, not live acceptance.
