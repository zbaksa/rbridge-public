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
- Ruling: T5-A — trusted fixed adapter ports are construction-time dependencies, never request-supplied callbacks, scripts, URLs or selectors. Existing V1 wiring and advertised capabilities remain gated by later feasibility and activation work. Cost if wrong: rework trusted adapter construction before opt-in.
- Ruling: T5-B — delivery uses a conservative public user-message DOM observation with exact UTF-8 text digest. DOM normalization or unavailable/ambiguous message identity is UNAVAILABLE; it is never assistant Markdown capture. Assistant original Markdown acquisition remains Task 6. Cost if wrong: legitimate delivery stays UNCERTAIN until the real representation is qualified.
- Ruling: T5-C — unsupported rollover acquisition is BLOCKED before navigation. A trusted site driver must prove support and quiescence; candidate URL alone never authorizes a positive binding receipt. Cost if wrong: rollover availability is delayed, without navigation.
- Ruling: T5-D — unknown click acknowledgement remains UNCERTAIN in this increment even if another observation appears; no guessed click timestamp or legacy caller-claimed verification. Durable late reconciliation remains Task 8. Cost if wrong: a delivered request can remain blocked pending its original evidence; no reclick.
- Owner boundary: one owning service worker and one authority store; no claim of distributed CAS or independent process exclusion. Source fixtures prove source behavior only, not live browser acceptance.
- Final branch review: required after implementation and full application verification; inherited deferred items stay visible.

## Task 6 — lossless acquisition availability gate

- Task 5 initial complete app verification: #12805 at source `e4c76339431bb4b0f38af31119268a8d6854f593`, UID/GID 1027, Node 22.23.2: 20 effect cases, 7 real-content fixture cases, full verify PASS. Live acceptance NOT_RUN; final whole-branch review and exact final CI remain required.
- Ruling: T6 — no validated site-provided exact-turn lossless representation is available through the authorized automated browser route. Implement the plan's explicit UNAVAILABLE/UI_PROTOCOL_CHANGED branch. A DOM Copy button, textContent, code-block reconstruction, private site state, and global clipboard cannot be used to claim original Markdown. Cost if wrong: positive lossless functionality remains unavailable until a genuine site representation is validated.
- The full positive lossless matrix is BLOCKED until a genuine site representation and exact provenance are established. Negative fixtures cover original Unicode/CRLF/fences, changed/user/tool roots and unrelated token; they prove fail-closed behavior only. No fake CAPTURED fixture is presented as a functioning site operation.
- This source fallback adds no capability advertisement, no V3 activation and no human/browser canary. Tasks 7–12 and real delivery/rollover feasibility remain pending.

## One final branch review and combined fix pass

- Fresh read-only review of `3a79d6d331e158f7f4b229d4eec1ba9b2064dcce..4a1eb9f1971c265077dbc5411b41747d2a05291b`: no Critical, three Important, no new Minor. Exact-head initial app verify #12807 and dedicated Linux/Windows CI 36871280901 / 36871280767 passed; source tests alone did not reveal these gaps.
- Actual RED #12812 at `fa1bd3a9ff5ace1f61643c2f7e547ee73a16cc98`, UID/GID1027: 20 PASS / 4 FAIL. Reproduces stale original live rollover target, effect-ledger poison during quiescence, same-owning-store generation drift at staging handoff, and analogous BIND phase drift.
- Combined fix pass: independently verify the original live target and authority after quiescence; retain a synchronous final authority/effect-ledger gate before navigation; pass expected snapshots through BIND, staging, intent and click; verify transactions against the immutable request before persisting intent. GREEN #12813 at source `2423a0bb84478bbb6ae2ed327004a10401f3b9b1`: 24/24 effects, 7/7 delivery content, 4/4 Markdown-unavailable; full npm verify PASS, UID/GID1027 Node22.23.2. No re-review requested.
- Inherited minor (deferred): trusted onServerHello hook receives the retained mutable negotiated object; current worker installs no such hook. Task 8 must deliver an immutable callback snapshot and retain sticky V3 authority.
- Inherited minor (deferred): exhaustive BIND successful-write followed by failed/missing/corrupt/superseded authority-readback fault cases. New delivery journal tests cover its prewrite/readback and post-click evidence-write failure; they do not pretend to cover every BIND backend fault.
- Final: fixed original-live rollover validation — `rollover_checks_original_live_target_before_navigation` RED→GREEN, full suite PASS.
- Final: fixed effect-ledger admission before navigation — `rollover_rechecks_ledger_admission_after_quiescence` RED→GREEN, full suite PASS.
- Final: fixed authority snapshot/request handoff — `staging_handoff_carries_original_authority_before_composer_mutation` and `binding_phase_handoff_carries_original_authority` RED→GREEN, full suite PASS.
- Final: Ruling: real ChatGPT DOM normalization/selectors/timing and delivery acceptance remain Task11 proof gates, because fixtures cannot prove a live session. Cost if wrong: live delivery remains unavailable and V3 is not enabled.
- Final: Ruling: functional site rollover acquisition stays unavailable until a trusted real route is proved. Cost if wrong: rollover remains BLOCKED before navigation.
- Final: Ruling: positive lossless export/provenance remains blocked by missing validated representation; negative tests are the allowed Task6 fallback. Cost if wrong: no original Markdown can qualify until corrected.
- Final: Ruling: late outcome reconciliation remains Task8; uncertain immutable effects are retained without reclicking. Cost if wrong: legitimate delivery may stay unresolved pending its real evidence.
- Final: Ruling: production V3 wiring, authenticated peer and response-event integration remain Tasks7–10, then acceptance/activation gates. Cost if wrong: the source cannot become an operational fallback.
- Final: Ruling: retained V1 caller-claimed verification/DOM assistant capture is compatibility history and cannot qualify V3. Cost if wrong: the new route must stay disabled until legacy isolation is proved.
- Final: Ruling: independent stores/workers/distributed CAS remain outside the one-worker/one-authority-store model. Cost if wrong: concurrent owners require stronger coordination before deployment.
- Final: Ruling: storage/OS crash durability remains a real backend/platform proof obligation; source verifies validation/readback only. Cost if wrong: interrupted effects remain uncertain and cannot authorize retry.
- Final: Ruling: Windows install/browser canaries remain NOT_RUN; CI artifacts prove build/staging only. Cost if wrong: source success cannot be promoted to live acceptance.

- Task5 source boundary: executor, observed delivery and conservative rollover source qualified; real delivery/site rollover acceptance NOT_RUN. Task6 negative fallback qualified; positive acquisition BLOCKED. Tasks7–10 implementation and Tasks11–12 live gates remain pending, not silently complete.
- Code-qualified log SHA256: effects `6524de283ad281d5eee3062167bd90173dbd80fab555a3751b60ee07da3b0c5f`, delivery `12952fe589b0c1244889d16a1b81a6094ebc026a29574ddbf1d1f5b881ac2da6`, Markdown `cb71da0d74d2435d9fcad5cef6c94da0b2be5f2c8b899f550700de39d8b7a4ae`, full verify `644501e193fc04b649f035b610d57785193581a482a5a552d42a9c736c46e791`. Final documentation-only source and CI qualification is recorded in the PR and paired continuation checkpoint, avoiding a self-referential source SHA in this file.

## Task 7 capture-egress source continuation

- Base `6e3c0188d179245234eada65573940b285947897` is qualified by app #12814 and exact Linux/Windows CI; Task5/6 PR7 remains draft/unmerged.
- TDD: capture runner covers durable ACK/retry dedup, full original string/digest, 16384-byte escaped wrapper overflow versus16385 oversize precedence, bounded receipt IDs/rejection floor, browser-supplied sender/frame/tab/URL/profile/live scope, token/epoch/request digest, forbidden authority fields, storage/prewrite/postwrite readback, port outage, restart, immutable snapshots and one event-sequence reservation for concurrent captures.
- Ruling: Task6 consumers use the already qualified `chatgptAssistantMarkdownCapture.ts` module/function and its existing runner name rather than duplicating a second adapter under the plan's descriptive filename. Cost if wrong: one path/runner rename; no lossless representation is invented.
- Ruling: V3 capture token includes the immutable request digest plus capture epoch, binding session/generation/attempt/effect/challenge through that digest. Historical V1 token remains compatibility-only and cannot authorize V3. Cost if wrong: V3 arming stays blocked until Task10 supplies the matching typed local context.
- Ruling: source egress can be qualified using authenticated controlled notifications while default actual site acquisition remains unavailable. Worker production V3 capture wiring stays gated by real adapter availability/negotiation; tests do not advertise or prove live capture. Cost if wrong: no source proof can authorize operational fallback.
- Task7 source IN_PROGRESS; Tasks8–10 remain pending. Fixed Linux endpoint is not installed, root R2 PENDING, Windows/browser/lossless acceptance NOT_RUN/BLOCKED.

## Task7 final source review and qualification

- Task7 source: complete within the deliberately closed production V3 gate (base6e3c0188d179245234eada65573940b285947897..730147d7511a8935627923ed50392fb9f3679472); npm run test:v3:capture20/20 and full npm run verify160PASS0FAIL as actual appUID/GID1027, Node22.23.2. Browser/site operation remains NOT_RUN. Final documentation-only head receives separate exact-head app/CI qualification in PR8 and the paired continuation checkpoint.
- First missing-component RED#12815 at a1187f0a1b66637b5b2bd4d05a881cc98332745b failed exactly missingegress/notifier exports. Initial implementation#12816 at e620a9060e51627f4dccf5ebd26b5c46dfb624e2 exposed an incorrect comparison of canonical project UUID with its exact URL slug (4PASS/14FAIL). The strict reserved request already validates both fields; exact binding comparisons use the full slug, independently verified live. Corrected#12817 at3d30b322d3f2169ee21c010594d0f2edc9b93e8b:18capture/full158PASS0FAIL.
- One fresh read-only whole-branch review6e3..3d30 found0Critical,1Important,0newMinor. Historical capture replay searched only newly recorded outbox entries, allowing an existing historical event ID to be appended at a new sequence/hash. Important re-grade retained.
- Actual review RED#12819 at a68ebd4bf182f669023c359053fd3aefceeedf87:18PASS/2FAIL. historical_capture_retry_returns_original_durable_ack_without_new_sequence and duplicate_historical_event_ids_are_rejected_even_with_valid_chain reproduced the conflicting ACK and missed collision.
- Final: fixed historical capture replay collision — both named regressions RED→GREEN, complete suite160/160. Capture/rejected/lost historical retries return the original durable event/hash, compare retained request/provenance/raw bytes or negative kind, and allocate no new sequence. The complete initial history is persisted with validated readback before its first ACK. Duplicate IDs are denied within history and across history/new records.
- Actual GREEN#12820 at730147d7511a8935627923ed50392fb9f3679472,treeec6ea27179a0c7aaf1bfd8eea65f67bbbff973c7:20/20capture,fullverify160PASS0FAIL/type/lint/server/extension/nativebundle/scrub/diffPASS; clean canonical production unchanged. Dedicated Linux36891283696 and Windows36891283793 PASS same head. No re-review requested.
- Code-qualified logsSHA256: capture a799a8dd1e1e0bde081533a18f863cb1baed2731214ab8864a47d6a04bc084e9; fullverify67146e20d5f666c3fcba8c91ebbf641ef59a0a6edd40312a4cd22276fe5ef0c6.
- Final: Ruling: explicitly supplied history belongs to the trusted Native/peer upgrade authority, must be validated as the complete EVENT_V1 prefix and registered with storage readback before a historical ACK. New chain ownership is never inferred from empty defaults in production; minor0 listener uses null gate. Cost if wrong: Task8/10 must keep V3 unavailable rather than reset or splice an unrelated Native history.
- Final: Ruling: bound raw notification intake at4MiB, independently of the accepted16384-byte response and4096..65536-byte wire envelope. Valid bounded oversize notifications get hashed rejection receipts; larger intake fails closed without ACK. Cost if wrong: a legitimate larger turn remains unacknowledged and needs a separately specified streaming/bounded acquisition path.
- Final: minor (deferred): inherited trusted HELLO callback immutability; no new Task7 hook changes this obligation for Task8.
- Final: minor (deferred): inherited exhaustive BIND post-write failed/missing/corrupt/superseded readback matrix.
- Ruling: retain this externally managed app worktree and tracked Native ledger while the approved plan continues. No local helper workspace was executed under the wrong identity; Task8–12 resume from canonical source rather than deleting app proof artifacts. Cost if wrong: bounded retained source/proof storage until the remaining plan can safely finish.
- The one-owner store assumption, original Markdown availability, fixed installed peer, typed request-bound capture arming, Native result/event ACK/replay, installed Windows host and real acceptance gates remain explicit. No V3 capability was advertised, no browser request/inference was sent, and no runtime/source promotion or schedule write occurred.

## 2026-10-02 Task8 Native transport increment

Continue from4e261f8; foundation and Task7 remain qualified history. GitHub main/runtime source are separate; COCWIN root repair qualified2a15b138, genuine R3 owner installation/activation pending. New branch is unmerged; completeTask8 and live acceptance remain OPEN.

Ruling: resume the existing isolated Task8 worktree at4e261f8 while retaining foundation commits/PR9 and Task7 donor; no production checkout change — same approved Native plan and clean exact app baseline — if wrong, discard the unmerged transport branch, not runtime.

Ruling: keep release SHA supplied from exact isolated HEAD for build env; baseline190 tests were green, failure was omitted required build pin — no source or capability change — if wrong, invalid artifact cannot qualify.

Ruling: Native result/event integration is a bounded source increment within open Task8. Fixed Linux spool, broker chunk/commit and C transport stay open until built/qualified; source6/12 remains unchanged — avoids treating protocol wiring as complete installed Task8 — if wrong, integration must be revised before opt-in.

Ruling: V3 configuration is trusted construction/approved private config, never browser input. Bind fixed peer/release/profile and approved full historical prefix to app owner; unknown historical ownership blocks — preserves V1 history and pending results — if wrong, legitimate upgrades stay blocked pending explicit ownership evidence.

Ruling: async V3 parser is added alongside frozen synchronous V1 parser; align both Native and extension consumers explicitly — preserves existing V1 caller interface — if wrong, unmerged source correction before any advertisement.

Ruling: add archival read/record operations for a previously reserved old-generation command, distinct from current-scope reserve/read/record. Only fixed transport uses archival evidence; it never grants current-session authority — preserves original late attempt — if wrong, no opt-in until correlation tests and review pass.

Pre-flight: strict V3 async validators consume immutable command; Native must reserve before browser output and record before peer send; resultStore current scope remains distinct from historical archived evidence; V1 event sequence never resets. Extension callback immutability/sticky V3 authority remains owed by Task8. C transport and broker deadlines remain subsequent source steps, not implemented by this Native increment.

### Native transport implementation candidate (source only)

- RED: GitHub bridge issue #12872; exact source `5a19b02c7a4000cf6a30d8eed383a5a649834c53`, actual app UID/GID 1027; compile PASS, 13/13 behavioral cases fail with the missing authority export. No runtime installation.
- Candidate adds immutable input snapshots, configured HELLO pin checks, private persistent app/peer/history authority, reservation before browser dispatch, result journal readback before peer forwarding, retained old-generation result correlation and original event/result replay. Async V3 routing remains separate from the frozen synchronous V1 parser.
- Ruling: keep this Native increment separate from the still pending fixed Linux peer, C broker transport and Task10 extension worker integration — each has its own wire/identity and TDD gate — cost if wrong: partial source must not be mistaken for operational V3 acceptance.
- Native runtime/config integration and whole-branch review are still pending; Task8 remains OPEN, qualified plan completion stays 6/12. Browser original Markdown and I1/I2/I3 remain blocked/not run. Production unchanged.

- Native relay candidate `913fbb15075a7b85fb9f1cffd8f13bdf5608563e`: bridge #12873, actual app1027 target13/13 PASS; full verify203/203 PASS, clean worktree. These qualify the relay source, not runtime wiring.
- Add runtime/config behavioral cases before implementation: complete strict private pins, actual framed Native runtime reservation/forwarding, and restart replay. Additional corruption/disconnect/input snapshot cases qualify the relay boundary.

- Runtime/config RED: bridge #12874 exact `367f5224e54a9ad8536e19b6c01686784248e75f`, actual app1027; compile PASS; 16 existing/relay checks PASS and 3 intended private config/runtime checks FAIL (`CONFIG_FIELDS_INVALID` / `V3_NOT_CONFIGURED`).
- Runtime candidate enables V3 only with explicit complete private configuration; default V3 stays closed. Existing extension worker still advertises V1, and Linux peer/C transport/Task10/installation are pending. Portable Windows CI explicitly runs the new Native transport suite before packaging.

- Runtime candidate `5a955a546445cd9e07e04c1512892c945c1be8f1`: bridge #12875 target19/19 PASS; full actual-app verify209/209 PASS, clean worktree. No installed V3 capability.
- Guard RED `7032f75cd3547ad939fe74f67abc864cf90ec65a`, bridge #12876: compile PASS, 19 PASS, 3 intended FAIL. A validly rehashed command could target a different pinned profile; invalid/oversize inputs threw synchronously from formerly async public methods. Fix validates complete parsed command target before reservation and preserves Promise rejection while taking the snapshot before any await.
