# P01 capture task settlement boundary

This source slice tracks only site capture work. It does not establish scope quiescence or authorize STOP_FINALIZED.

The real Chrome reader will expose startAcquire(request, delivery, prepareAdmission), returning {result, settled}. result retains the existing bounded wrapper deadline. settled resolves only from the underlying acquireOnce finally, with {outcome: COMPLETED|FAILED, copyIssued: boolean}. Wrapper expiry never resolves settled and never cancels a queued Chrome script. Every late rejection is observed.

A capture-specific store persists one original identity (exact owner, appId, baseSha, sessionId, generation, requestDigest, effectId, attemptId, target and captureEpoch) before the reader can enqueue Chrome work. Up to 128 original identities are retained. Each identity retains a bounded monotonic sequence of raw tasks; settled read-only NOT_READY probes may continue without consuming another original identity. Pending, quarantine, unsupported raw settlement or any issued Copy prevents another acquisition. This preserves the existing polling deadline instead of silently reducing it to 128 polls.

Each raw task is durably reserved PENDING with digest/readback before startAcquire. The existing async prepareAdmission boundary durably arms Copy before returning its final synchronous permit. The permit rechecks peer, scope, authority and STOP after persistence. Only the actual raw settlement records COMPLETED or FAILED and copyIssued; timeout records sticky quarantine independently. Later raw completion never clears quarantine or creates a full capture receipt.

A fresh original identity needs a closure-bound, single-use permit issued only when this worker's executor actually performed a NEW SEND and returned VERIFIED. Replayed/reconciled results do not issue it. Missing marker on an older uncaptured SEND is unproven and fails closed. Retained exact full capture events remain reusable without another Copy.

The store keeps all original records, rejects changed ownership/scope/identities and rollback, and poisons on uncertain writes/readback. It never deletes or rekeys a record. facts(scope) reports bounded retained history, pending and quarantine counts, Copy-issued facts and digest; absent history remains explicitly ABSENT. These are activity facts, not captured-response or quiescence proof.

The real pinned Chrome reader implements the raw handle. Legacy acquire() remains available as a result-only helper. Egress requires startAcquire and never guesses that a third-party wrapper promise is underlying settlement. Synthetic test readers provide honest raw handles explicitly.

Relevant races: timeout while MAIN injection is unresolved; reload/fresh adapter before late injection resolves; STOP while final admission is delayed; storage failure before first injection; late raw completion after wrapper expiry; exact duplicate/collision and retained foreign-scope data.
