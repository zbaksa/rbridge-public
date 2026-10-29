# Native scoped result inventory implementation plan

> **For agentic workers:** Execute this isolated result-store slice directly with regression-first AppUID1027 qualification.

**Goal:** Expose retained scoped command/result evidence, including null reservations, without claiming quiescence.

**Architecture:** Reuse the existing private result-store gate and full journal parser. Return counts plus deterministic sorted evidence and envelope digests; preserve all original journal and authority bytes.

**Tech Stack:** TypeScript, Node22, Vitest, real private filesystem stores.

**Spec:** Parent-authorized COCWIN071 native inventory slice; no CLI, wire, capability or activation change.

## Contract

`readScopeInventory(scopeInput:V3Scope):Promise<RbridgeScopeResultInventoryV1>` returns `{schema:'RBRIDGE_NATIVE_SCOPE_RESULT_INVENTORY_V1',scope,entryCount,unresolvedCount,entriesSha256,sha256}`. Exact validated input scope equals all four configured fields. Only exact scoped retained entries contribute. Sort by commandId. `entriesSha256` commits full `{command,result,resolvedByCommandId}` tuples; direct VERIFIED/FAILED_SAFE evidence resolves itself; otherwise only a retained VERIFIED/FAILED_SAFE RECONCILE with canonically equal full request resolves an entry. Other EXECUTEs never resolve history. The envelope sha256 commits every field except itself. No PASS/readiness/capture/drain status.

History-readonly means no ledger or history-authority write; the existing private gate may create/remove its lock or private directory. Missing/corrupt committed history remains rejected by existing validation. No post, replay, cleanup, mutation, history deletion or new dependency.

## Review focus

- Null reservations remain visible across reopen.
- Scope aliases, extra fields and foreign identities fail before selecting history.
- A terminal unrelated request or EXECUTE cannot erase unresolved evidence.
- Canonically equal full-request RECONCILE is necessary, including exact generation/base/target.
- Digest ordering is deterministic and original bytes remain unchanged.

## Task

- [x] Write `tests/w1-v3-native-inventory.test.ts` covering empty/null/terminal/uncertain/mismatched reconciliation, deterministic ordering, reopen, exact scopes and unchanged journal/authority bytes.
- [x] Run targeted Vitest under actual RAppUID1027 and qualification flock; expect missing `readScopeInventory` assertion failures.
- [x] Add exported inventory interface and method only in `src/nativeHost/rbridgeEffectResultStore.ts`.
- [x] Run targeted GREEN plus existing native-results suite, typecheck and touched-file lint under the same gate; inspect all return codes.
- [x] Return exact diff/file pack and evidence for review; do not commit/push. Parent runs shared full release qualification after integrating the independent worker slice.

## Actual qualification

Final RED: issue23479/comment6508527115, actualUID/GID1027,18 expected missing-method failures, no timeout/truncation. GREEN: issue23482/comment6508541587,new18/18 and existing native-results30/30, typecheck/build/touchedlint/diffcheck all0. No wire/CLI/capability or production activation change. Full shared qualification is coordinated by parent after worker integration.
