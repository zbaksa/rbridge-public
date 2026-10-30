# P01 authenticated Worker scope STOP seal

This source adds the raw RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1 handler to the qualified V3 Worker composition. The generic minor0 startup remains unchanged. The capability is advertised only when the approved immutable startup peer explicitly includes CHAT_SCOPE_QUIESCENCE_V1.

The Native-port link admits only the original privately received query object after negotiated capability checks. The composition independently checks the complete current scope and canonical digest of its approved startup peer pins, and checks query freshness before work and immediately before posting. The Linux channel ID remains opaque authenticated correlation. A new HELLO, disconnect, or another port epoch invalidates an admitted query; an asynchronous digest cannot post into that changed epoch.

The original immutable STOP_REQUESTED fence is durably recorded before browser control. BrowserAuthorityRuntime stops the actual content capture with CAPTURE_STOP and requires OFF before committing LOST capture and RELEASED leader under unchanged binding, epochs, revision and admission fences. It preserves activeSend and retained history. No stopSend or fabricated response completion is used.

The report inventories every retained command, including null reservations. Only a terminal full-request RECONCILE can resolve a prior command's uncertainty. SEND additionally needs a complete validated ASSISTANT_TURN_CAPTURED_V2 receipt and RESPONSE_VERIFIED for a current transaction. Legacy uncaptured SEND has no inferred fresh capture permission.

Whole effect/read callbacks and other controls are counted until actual completion. Durable raw Chrome activity is distinct from a wrapper timeout: the pending marker is written before enqueue, and timeout quarantine remains retained across a fresh storage adapter. A timed-out Promise.race does not settle Chrome's queued task. Settled read-only NOT_READY probes may poll; an actual copied or quarantined identity cannot copy again. Limits are 128 identities and 4096 retained raw tasks with monotonic history.

A sealed report requires actual capture OFF and durable leader RELEASED, no pending callbacks/readers/flushes, no unresolved capture, and a fully resolved factual command inventory. A final synchronous admission guard checks activity and port epoch after report validation. Retained outbox events remain history rather than a pending-delivery count. Its complete retained event head is reported; Native and Linux must independently match that head before a remote PASS.

The storage adapters follow the established one live MV3 Worker convention. Process-local gates do not claim a distributed cross-worker lock. Storage errors, lost readback, navigation, pending late tasks, or port changes fail closed. These tests qualify source behavior; they do not constitute Windows, production startup, provider, or live end-to-end acceptance.

The seal observation also samples whole handlers, durable raw-reader activity, active flushes and inventory before actual OFF. Work that drains during OFF cannot establish captureStopped or a seal for that query; a fresh query must observe the drained boundary and obtain actual OFF again. The reported pending counters remain observed work facts, while sealed is additionally constrained by the complete before/after interval.
