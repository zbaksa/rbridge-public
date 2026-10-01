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

## Task 5 continuation — browser effect source

- Status: IN_PROGRESS; isolated source branch starts at the qualified binding foundation `3a79d6d331e158f7f4b229d4eec1ba9b2064dcce`. Existing production checkout is outside this worktree.
- RED first: independent effect tests cover durable baseline-before-intent/click, exact new user-turn digest, observed delivery before VERIFIED, historical/mismatched/multiple turn rejection, document reload, every target dimension, storage/readback failure, replay/restart, and rollover scope/quiescence/overflow.
- Ruling T5-A: trusted fixed adapter ports are construction-time dependencies, never request-supplied callbacks, scripts, URLs or selectors. Existing V1 wiring and advertised capabilities remain gated by later feasibility and activation work.
- Ruling T5-B: delivery uses a conservative public user-message DOM observation with exact UTF-8 text digest. DOM normalization or unavailable/ambiguous message identity is UNAVAILABLE; it is never assistant Markdown capture. Assistant original Markdown acquisition remains Task 6.
- Ruling T5-C: unsupported rollover acquisition is BLOCKED before navigation. A trusted site driver must prove support and quiescence; candidate URL alone never authorizes a positive binding receipt.
- Ruling T5-D: unknown click acknowledgement remains UNCERTAIN in this increment even if another observation appears; no guessed click timestamp or legacy caller-claimed verification. Durable late reconciliation remains Task 8.
- Owner boundary: one owning service worker and one authority store; no claim of distributed CAS or independent process exclusion. Source fixtures prove source behavior only, not live browser acceptance.
- Final branch review: required after implementation and full application verification; inherited deferred items stay visible.

## Task 6 — lossless acquisition availability gate

- Task 5 initial complete app verification: #12805 at source `e4c76339431bb4b0f38af31119268a8d6854f593`, UID/GID 1027, Node 22.23.2: 20 effect cases, 7 real-content fixture cases, full verify PASS. Live acceptance NOT_RUN; final whole-branch review and exact final CI remain required.
- Task 6 ruling: no validated site-provided exact-turn lossless representation is available through the authorized automated browser route. Implement the plan's explicit UNAVAILABLE/UI_PROTOCOL_CHANGED branch. A DOM Copy button, textContent, code-block reconstruction, private site state, and global clipboard cannot be used to claim original Markdown.
- The full positive lossless matrix is BLOCKED until a genuine site representation and exact provenance are established. Negative fixtures cover original Unicode/CRLF/fences, changed/user/tool roots and unrelated token; they prove fail-closed behavior only. No fake CAPTURED fixture is presented as a functioning site operation.
- This source fallback adds no capability advertisement, no V3 activation and no human/browser canary. Tasks 7–12 and real delivery/rollover feasibility remain pending.
