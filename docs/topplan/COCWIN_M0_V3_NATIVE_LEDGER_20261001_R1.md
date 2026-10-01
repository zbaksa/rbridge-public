# SDD ledger — plan: docs/superpowers/plans/2026-09-30-cocwin-m0-v3-integration.md

2026-10-01 Native continuation. Architectural spec and Native implementation were approved; resume Task1 without repeating design or plan approval. Tasks complete:0/12. Previously merged canonicalJson/sha256Hex/canonicalDigest and32tests are reused as partial foundation.

Current C source8170e4e11758e1341582a680088dd5d8b24d551c/treeb94e980570a28b79c3e2b6710930a8f6347c6d87. R safety source69396cf43de0ba47986352520ec3655d73adf727/treec4ebbb956ca01ee57aac7e74088c3c1845a2cbe0; R canonicalmain5ca94ad6733bfda752c450ae821c6fa227303dcf is separate. Root observer#12744 at2026-10-01T05:42:14Z proves old cleanC0d4da runtime and genuine approvalonly0d4da, noacceptedR2. Main8170 remains pinned for ownerR2; newC/R changes stayisolated andunmerged untilactivation/reconciliation.

Ruling: use existing approved Remote Bridge APP_RUN/app-owned .cocwin-worktrees and GitHub source control rather than local skill worktree helpers — actualrepositories and appUIDs liveon aether-engine, while scratch is onlyan editing surface. Manual taskledger carries thesame planidentity and exactRED/GREEN/BASE/commit evidence; costifwrong: ledger migration, no production scope change.

Ruling: retain existing Canonical JSONV1 semantics unchanged. New strictwire parsers reject unknown/missing fields before digesting, including request-controlled executable/URL/path fields. Projectidentity uses theexisting exact canonicalProjectId parser behavior, never prefix matching; costifwrong: candidate remains disabled pendingpaired review.

Pre-flight: Task1 supplies strictrequest/command/result/captureevent parsers andV3peer capability guard consumedbyTasks2,3,4,7,8,9. Durable authority andpeer authentication remain later tasks; a structurallyvalidpeer isnot anauthenticatedconnection. Task1 doesnot enableproductioncapabilities/browserrouting. Full-turn REJECTED budget validation cannot recompute omittedtext; itvalidates count/reason consistency andcompleteevent ceiling, while exact-turn provenance remainsTask6/7 responsibility.

## 2026-10-01 Task 1 evidence and scalar rulings

- RED: C #12745 (32 historical PASS, 13 V3 missing-export failures), R #12746 (missing protocol module). Actual app UIDs/GIDs 1023/1027, Node 22.23.2, isolated linked worktrees; production unchanged, no inference.
- First parser qualification: C #12747 at edc2521206d96daa717b0a0506382de6edea4ee6 PASS: 45 tests, typecheck, lint, server build. R #12748 at a0f0a90d1aae7b95703f9959ec20df7059c77645: 13 contract cases PASS, newly added core HELLO regression FAIL as expected before core alignment. Broker envelope PASS means execution delivered; nested candidate status remains FAIL.
- Attempts retain positive canonical decimal suffixes and additionally reject counters above MAX_SAFE_INTEGER, consistent with V3's precise counters and bounded metadata.
- Browser/profile/project/conversation IDs keep inherited non-C0/DEL UTF-8 bounds. New V2 receipt/turn and command/event IDs use the specified bounded ASCII rules. Historical V1 validators are unchanged.
- Rollover CREATE_NEXT requires a different observed conversation ID; next generation is current+1 and cannot overflow 2147483647. Full non-VERIFIED evidence is limited to negative SEND receipts; it cannot authorize progress.
- Timestamps are canonical UTC and digest-bound. No cross-host clock ordering assumption is imposed on independently observed receipts.
- Required catalogs are mirrored byte-for-byte in RBridge documentation so both consumers can inspect the same pending contract; this adds no runtime route or capability advertisement.
- The fixtures remain the independent fixed Python outputs, SHA-256 8c77656e4783ecda0067417f3cd795bee667cdc39445f30028afb40cbbf02f2c.
