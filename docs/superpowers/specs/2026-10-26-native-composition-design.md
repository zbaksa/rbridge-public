# Qualified V3 Native/browser composition

Supply one side-effect-free `startQualifiedExtensionServiceWorkerV3(api, releaseSha, options)` entry that composes the existing Native link, durable effect dispatcher/executor, browser runtime, delivery proof and capture outbox. No transport, controller, credentials or wire schema changes.

The caller provides authenticated pinned VerifiedPeerV3, bootstrap browser/profile identity, immutable app/base/session/generation scope, historical event chain and an independently qualified SiteMarkdownReaderV3. A HELLO digest is not authentication. The released minor0 serviceWorkerEntry, installed Native configuration and legacy unavailable adapter remain unchanged. This source entry alone does not authorize real activation.

Validate configuration, historical chain, peer and scope before browser admission. Require an original scoped effect-ledger request for every initial/outbox event origin and retained active SEND before connecting. Preserve pending/UNCERTAIN origins; never recreate them from history. Commands arriving during pinned HELLO history validation wait for that handshake while retaining their original Native epoch.

Only the original received Native command reference acquires admittedEffect context. Retain a private original snapshot and current-connection assertion; apply it before execution, at final SEND click and rollover navigation, immediately before MAIN Copy, and across asynchronous result/event posting. Reject wrong app/base/session/generation/profile before reservation. Keep V1 READ_STATE/DISCOVER compatibility without V1 mutations.

After a VERIFIED SEND or reconciliation of that same SEND, poll capture for its matching active transaction and derive lease/sender from durable runtime state. Default timeout120000ms/poll250ms; qualification bounds1..120000ms and1..5000ms. Coalesce per request digest. Use existing exact site reader and durable egress/completion; no new SEND/LLM call on poll, timeout or replay. Missing response preserves unresolved SEND; rejected/lost response remains a terminal event without completion.

A Copy already admitted may finish into local durable storage after disconnect, but cannot post into another Native epoch. Local CAPTURED is not a Native durable ACK. Reconnect flushes original events. Content hints remain closed and cannot acquire Native authority. Rollover retains its unavailable driver until separately qualified.

Qualify regression-first under normal RBridge1027, one fresh whole-component review, exact canonical Linux/Windows CI and real Chrome offline UI/storage through a synthetic Native peer. Report fixture/authentication boundaries; actual owner Windows/private AI acceptance remains separate.
