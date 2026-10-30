# P01 capture settlement implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Prevent a timed-out or reloaded capture from forgetting pending Chrome Copy work or starting a second Copy.

**Architecture:** Extend the real reader with an explicit raw-task handle, use a capture-only durable activity store around that handle, and mint a single-use fresh-SEND closure in the existing composition. Capture event/effect/outbox history stays intact. Activity facts never return quiescence PASS.

**Tech Stack:** TypeScript, existing Chrome adapter/storage contracts, canonical SHA256 JSON, approved R APP_RUN relay.

**Spec:** docs/superpowers/specs/2026-10-29-p01-capture-task-settlement.md

## Constraints

- Worktree parent08b8dede5c7f2df3dafdd5a56eb239171823446b; actual R UID/GID1027 only.
- All source writes and qualification hold the new qualification.lock.
- No domain, package, Native/CLI, wire-version or live activation edits.
- Preserve original scope, requests, effects, capture events and uncertain outcomes.
- Bound original capture identities to128; fail closed on exhaustion.
- Keep raw settlement separate from wrapper timeout and captured-response proof.

## Review focus

- A wrapper timeout while Chrome remains deferred cannot become idle or permit another Copy after reload.
- Accepted-but-unverified storage writes cannot admit Chrome.
- Fresh SEND authorization cannot be replayed, transferred to another identity or minted by a caller boolean.
- Late raw settlement cannot erase quarantine or manufacture a capture event.
- Normal NOT_READY polling and healthy one-prompt full capture still work.

### Task 1: Reader, durable capture marker and composition permit

Files: src/extension/chromeAuthorityAdapters.ts, src/extension/rbridgeCaptureEgress.ts, new src/extension/siteCaptureActivityStore.ts, minimal src/extension/serviceWorkerCompositionV3.ts hook, relevant site-reader/capture-egress/worker fixtures and tests.

Interfaces: startAcquire(...)->{result,settled}; capture-specific begin/arm/quarantine/settle lease; facts(scope); egress siteActivityFacts(scope). No quiescence API.

- [ ] Establish original targeted baseline in the actual R App.
- [ ] Add deferred real-Chrome regression and observe behavioral RED.
- [ ] Implement raw task handle and capture-only durable state.
- [ ] Wire exact fresh-SEND closure and update honest synthetic raw-handle fixtures.
- [ ] Observe targeted GREEN, typecheck, touched lint and diff check.
- [ ] Emit exact source packet and receipts for independent review; leave uncommitted.
