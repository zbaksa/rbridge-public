# P01 scope quiescence contract implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this contract slice.

**Goal:** Define exact STOP/barrier evidence envelopes and optional capability negotiation without claiming live quiescence.

**Architecture:** Pure domain builders and parsers preserve the immutable first STOP request. A fresh Linux-clock query binds its original request to one authenticated channel and pin digest. Worker and Native reports carry facts; a later Linux consumer derives the final decision.

**Tech Stack:** TypeScript, existing canonical JSON/SHA256, Vitest.

**Spec:** This document and the parent-authorized P01 minimum: original scope, one prompt, full capture, verified STOP.

## Global constraints

- Actual source/test writes and execution use R App UID/GID1027 and this worktree's qualification lock.
- Preserve the existing STOP request/fence schema and bytes; field name is issuedAt.
- Query lifetime is exactly 30000ms on the Linux clock; report timestamps are structurally canonical ISO only.
- Global V3 required capabilities stay unchanged. Negotiate CHAT_SCOPE_QUIESCENCE_V1 only when both minor-one peers explicitly advertise it; this slice advertises nothing.
- No wire/CLI/worker handler, filesystem authority, source activation, scheduler or provider changes.

## Review focus

- Hostile/accessor objects fail before getters run; all intake is synchronously snapshotted and bounded.
- Scope, original challenge, nonce, channel, pin and digest mismatches reject even after attacker recomputes outer hashes.
- Retained expired records remain parseable; explicit current-query assertion enforces live channel/pins/window.
- Factual nonzero or mismatched observations remain facts, never a copied PASS.
- No completed receipt, HELLO, READ_STATE or postMessage substitutes for durable remote evidence.

## Contract and ownership

Create src/domain/rbridgeScopeQuiescence.ts, tests/w1-v3-scope-quiescence.test.ts. Modify only optional capability intersection in src/domain/rbridgeChatCore.ts and package test wiring.

Exports: parseScopeStopRequest/buildScopeStopRequest; parseScopeQuiescenceQuery/buildScopeQuiescenceQuery/assertScopeQuiescenceQueryCurrent; parseScopeResultInventory/buildScopeResultInventory; parseWorkerQuiescenceReport/buildWorkerQuiescenceReport; parseNativeQuiescenceReport/buildNativeQuiescenceReport; parseScopeQuiescenceRecord/buildScopeQuiescenceRecord.

STOP request/fence fields match existing store. Query exact fields: schema,queryId,queryNonce,request,channelId,peerPinsSha256,submittedAt,expiresAt,sha256. Generic wire inventory schema RBRIDGE_SCOPE_RESULT_INVENTORY_V1 contains scope,entryCount,unresolvedCount,entriesSha256,sha256. Existing Native API keeps its Native schema unchanged.

Worker exact fields: schema,querySha256,fence,sealed,captureStopped,pendingHandlers,pendingReaders,pendingEgress,unresolvedCaptureCount,resultInventory,eventHead,observedAt,sha256. Native exact fields: schema,querySha256,worker,resultInventory,eventHead,observedAt,sha256. Record exact fields: schema,query,state,nativeReport,receivedAt,sha256. QUEUED/DISPATCHED records require null report/time. COMPLETE requires correlated report and reception in the query window. All envelope hashes exclude only their own hash field.

### Task 1: Shared contract and optional negotiation

- [x] Write independent manually signed positive/negative vectors, including compatibility with the existing stop store.
- [x] Observe actual App feature-missing RED, with valid compilation.
- [x] Implement minimal pure domain builders/parsers and optional negotiation.
- [x] Observe targeted GREEN, build/typecheck/touched lint and diff check; report exact receipts.
- [ ] Independent review before commit. Parent coordinates full suite after consumers integrate.

## Remaining full barrier boundary

This contract alone proves no quiescence. Later work must install durable Linux admission fencing without draining queued SENDs; forward controls through Native; compare worker/Native/Linux durable heads and inventories; and persist C's first STOP identity before submission.

Capture needs a CAPTURE-specific durable pending reservation before actual Copy/injection. A queued executeScript may start after the old worker times out or reloads; a fresh reader can otherwise complete before that old injection starts. Retain PENDING across reload and forbid a second Copy until genuine underlying settlement. Never settle on the public timeout wrapper. A retained uncaptured SEND from before this source must block fresh Copy unless a genuine prior reservation proves safe ownership. No generic activity registry or history reset is authorized.

## Actual App qualification

- #23520/comment6508955527: UID/GID1027, build0, valid missing-feature RED21FAIL/1PASS (22tests).
- #23521/comment6508984717: build0, intermediate20PASS/2FAIL. One genuine queryId192-vs191 boundary bug; one malformed fractional test vector threw during independent signing before reaching parser. Both corrected without weakening parser assertions.
- #23524/comment6509003466: UID/GID1027, build0, targeted25/25PASS, touched-domain/core/test ESLint0, diff-check0. No timeout/truncation.

No commit, full-suite claim, consumer wiring or live proof in this slice. Readback consumers must compare the entire expected query (including nonce and immutable request) before applying assertScopeQuiescenceQueryCurrent; its current-channel checks are not expected-request correlation.
