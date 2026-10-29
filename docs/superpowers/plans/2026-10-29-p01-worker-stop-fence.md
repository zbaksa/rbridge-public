# P01 worker scope STOP fence implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Persist a terminal fence for the already qualified original V3 scope so a STOP request prevents another EXECUTE, including after worker reload.

**Architecture:** A scope-bound store owns one immutable STOP_REQUESTED record under Chrome local storage, validates exact request identity and digest, and checks durable readback. The composition checks this store before EXECUTE admission and at its existing final SEND/Copy admission checks. RECONCILE keeps its original outcome and retained history. This slice does not claim remote quiescence, capture cancellation, durable Native acknowledgment, STOP_FINALIZED, or deployment.

**Tech Stack:** TypeScript, Chrome storage adapter, existing V3 SHA256 canonical JSON and synthetic Native/content regression suite.

**Spec:** This design in this plan, limited to the first durable admission-fence slice.

## Global constraints

- Preserve appId, baseSha, sessionId and generation exactly; reject a retained fence for another scope.
- Preserve every effect result, capture event, original request, uncertain outcome and outbox record.
- No wire/Native/CLI/version/production activation changes in this slice.
- All source/test execution runs through approved APP_RUN as R UID/GID 1027.

## Review focus

- New EXECUTE after STOP is explicitly rejected before reservation or external work; it gets no fabricated result, leaving transport uncertainty retained. Completed command replays return exact original result bytes.
- Reload must retain STOP; malformed, missing-after-seen, rolled-back or unreadable stop data must fail closed.
- A STOP arriving while SEND awaits its final preflight must prevent its click.
- A same-ID collision or mismatched scope must not replace the original stop request.
- RECONCILE after STOP must remain readable and must not restart capture.

### Task 1: Durable scope store and composition admission

Files: create src/extension/rbridgeScopeStopStore.ts; modify src/extension/serviceWorkerCompositionV3.ts; extend tests/w1-v3-worker-composition.ts.

Interfaces: RbridgeScopeStopStoreV1.initialize(), assertExecuteAllowed(), requestStop(input), stopped; composition requestScopeStop(input), stopped. Request schema RBRIDGE_SCOPE_STOP_REQUEST_V1 contains requestId, exact scope, challenge, issuedAt, requestDigest. The fence schema RBRIDGE_SCOPE_STOP_FENCE_V1 contains the original request, state STOP_REQUESTED, recordedAt and sha256.

- [x] Establish baseline: actual R App build and existing 19 worker composition tests.
- [x] Add regressions and observe actual missing STOP behavior (new final SEND click and Copy both occurred before the fix).
- [x] Implement the immutable scope store, synchronous pending-stop admission block, poisoning on uncertain storage, and composition integration.
- [x] Observe targeted GREEN, TypeScript build, touched-file lint and diff check.
- [x] Report exact evidence and remaining full-barrier boundary for independent review.

## Actual R App qualification evidence

- #23465/comment6508458318: UID/GID1027, build PASS, existing worker19/19.
- #23467/comment6508474767: invalid initial test compile (await typo), retained and corrected; not RED evidence.
- #23468/comment6508489617: feature-missing RED, existing19PASS/new11FAIL.
- #23472/comment6508508206: actual-behavior RED, build PASS, original19PASS/new11FAIL; final SEND click1!=0 and Copy1!=0.
- #23478/comment6508525268: intermediate build and worker30/30 PASS.
- #23483/comment6508544978: replay RED,31PASS/2FAIL; completed result replacement and unstable denied-result timestamps.
- #23486/comment6508564464: explicit-rejection/replay/collision RED,27PASS/6FAIL.
- #23488/comment6508574138: final build PASS, worker33/33, touched-three-file ESLint PASS, git diff --check PASS. Every job above reports no timeout or truncation.

Full repository verification is coordinated separately after the Native inventory slice. No wire STOP command, Native/Linux durable head comparison, queued-work drain, quarantine recovery or quiescence PASS exists in this slice. A new post-STOP EXECUTE is rejected without a result; its sender retains uncertainty. Completed original command replay returns its exact immutable result.
