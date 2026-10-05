# P2A installation transaction and reader acceptance

Status: **DRAFT — written specification awaiting owner review.** Prepared 2026-10-05 UTC. This document specifies a future installation tool and its qualification. It is neither an executable runbook nor production-switch permission. The approved P2A source design and 13-task implementation remain complete; this is a separate installation design.

## 1. Outcome and boundary

Install one exact, qualified P2A artifact under the existing non-root runtime identity, preserving legacy request, FlowPilot, process and transfer history. Accept it only after authenticated GitHub and MCP results agree with the installed binding and actual result readers accept the new format. Installation failure before a candidate start may restore the old release under strict checks. Any attempted candidate start blocks automatic old-release restart; recovery then preserves new evidence and requires a compatible, separately authorized path.

The source candidate is `b5881fd8367b4249e82683f1f884f2392cb696d4`, tree `8eeabd5628c8226bd42c00d79e2f3c37ad252ba8`, in [draft PR #32](https://github.com/zbaksa/rbridge-public/pull/32). [CI run 37348309387](https://github.com/zbaksa/rbridge-public/actions/runs/37348309387) qualified 531/531 tests in 55 files, typecheck, lint, server build, public-source scrub and tracked-source cleanliness on Node 22.23.3. Its synthetic merge `810f3fadc86011070386f24f44ea735f0abee071` has this exact tree. That is source qualification; it does not qualify a production artifact or installed client. Adding this documentation does not extend those runtime test claims to a new tree.

Archived live observations identify old release `008885e07394f20746f034cbd7fe52c6b520533d`, Node 22.23.2, UID/GID 1027, a private ext4 state root, absent Core state/candidate installation, and missing explicit principal/target configuration. They also identify a runtime CPUQuota drop-in. These are timestamped live observations in the private continuation record, not an offline installation gate. The historical c69 deployment script must not be reused as a P2A installer.

Installation scope includes explicit identity/release configuration, immutable artifact publication, complete paused backup and state validation, source/transport/reader acceptance and crash-aware maintenance recovery. It excludes new Core PROCESS or mutating FILE capabilities, app-job canaries, HTTP transport, policy-root expansion, credential rotation, legacy record rewriting and continuity migration. Existing APP_RUN remains legacy. Existing admission begins normally when the candidate starts; this design adds no runtime admission fence.

## 2. Architectural choice

| Approach | Benefit | Cost and limitation | Decision |
| --- | --- | --- | --- |
| Strict pre-start restoration; post-start hold or compatible recovery | Installs the existing candidate without changing runtime admission or identity semantics | A failed post-start acceptance may require a stopped maintenance state; old restart is deliberately unavailable | **Recommended for this narrow installation** |
| New install-only admission fence | Could constrain both transports and legacy/FlowPilot during acceptance | Requires a separate runtime design, all ingress coverage, persistent recovery semantics and source qualification; no such fence exists in this candidate | Separate future scope if stopped recovery is unacceptable |
| Backport Core reservations/continuity to the old release | Could permit a qualified return while preserving every new identity | Changes old legacy and FlowPilot admission, all collision/replay paths and migration rules; much broader than installation | Separate continuity design |

The compatibility boundary comes from source, not an observed duplicate production action. P2A checks legacy filenames/tombstones before Core claims and checks Core journal identities before legacy/FlowPilot claims (`src/server/rbridgeLegacyReservations.ts`). Old 008 has neither the Core journal guard in its worker nor the FlowPilot claim guard. A closed, published HEALTH/FILE canary or a durable BLOCKED receipt still reserves an ID that old 008 does not understand. Issue closure and read-only execution do not remove this boundary.

Candidate main acquires relay exclusion, starts the Core owner/recovery/IPC, initializes guarded legacy engines, starts optional FlowPilot and then polls ordinary work (`src/server/remoteBridgeMain.ts`). There is no allowlist admitting only installer canaries. Pausing known producers reduces traffic but is not a verified internal fence.

## 3. Deployment profile and trusted binding

Before implementation qualification, produce one reviewed private deployment profile with exact bytes for:

| Field | Required invariant |
| --- | --- |
| Source and artifact | Exact commit/tree, Node/npm executable versions and hashes, build commands, lockfile and complete production artifact manifest |
| OS authority | UID/GID 1027, real/effective UID match, verified runtime account/home and supplementary groups |
| Core scope | One explicit immutable `RBRIDGE_MCP_PRINCIPAL_ID` and `RBRIDGE_INSTANCE_ID`, valid P0 syntax; never a new value per client or canary |
| GitHub authority | Expected repository and author, separately pinned from Core scope; bounded authenticated lookup context |
| Adapter subjects | Trusted `uid:1027` MCP subject and repository/author GitHub subject; callers cannot select these through tool arguments |
| Policy | Exact compiled policy and capability/path-root fingerprint; PROCESS and Core mutations remain disabled |
| Service/config | Existing fragment, complete drop-in set, EnvironmentFile order/hashes, effective hardening, writable roots, executable path and stop behavior |
| Acceptance | Registered actual readers, client versions, predeclared unique operation IDs and exact nonsensitive FILE canary bytes |
| Maintenance | Protected ledger/backup/release parents, budgets, lock path and owner-present execution window |

The private continuation proposes one human-readable principal and host target for owner review; neither has been installed or approved as a production binding. The public spec intentionally does not publish private deployment coordinates. No machine-ID fallback is used: P2A main calls the explicit MCP binding resolver. Old 008 did not configure an instance ID or scoped-store digest, so there is no scoped target from 008 to preserve. Existing unscoped history stays unscoped; it is never relabeled to fit the new scope.

The Core manifest pins UID/principal/target (`src/server/rbridgeExecutionJournal.ts`), while trusted repository/author remain outside that manifest and Core intent digest. Legacy scope hashes repository/author/instance. Refuse drift in the full profile even when a Core manifest alone still matches. Same-UID clients share the account's authority; client labels do not provide another authentication boundary.

## 4. Build and immutable artifact

Build before downtime in a fresh isolated non-root stage, from the exact candidate. Pin a trusted absolute Node 22 executable. Qualify the production Node 22.23.2 runtime separately from the existing Node 22.23.3 CI proof; do not silently upgrade production. Dependency commands never run as root. Use the lockfile, disable install scripts/audit/fund, build with development dependencies, then create a separate production dependency material. Recompute its manifest after any prune or reinstall.

The canonical artifact manifest covers every shipped directory, regular file and explicitly allowed confined relative symlink: relative path, kind, size, SHA256 or symlink target, and approved mode. Include package metadata, compiled server entrypoints and their import closure, complete transitive production `node_modules`, and any shipped maps. Reject unexpected files, special objects, escaping links, unexpected hard links and setuid/setgid bits. A Git tree, lockfile integrity string or `dist` digest alone is insufficient.

Run isolated non-root boot/IPC and reader fixtures against this final material and isolated state. Do not run production operations while staging. Capture exact commands, exit codes and logs without secrets. Source test evidence stays attached to its tested tree; artifact fixture evidence is a separate qualification.

Root publication uses a reviewed no-follow descriptor copier into a new root-owned temporary release directory. Validate every ancestor and object before opening; recheck descriptor identity and hashes after copy. Copy only the manifest allowlist. Root must not execute runtime-owned build helpers or import runtime-owned modules. Refuse a pre-existing final release path rather than overwrite it. Fsync files/directories, atomically rename on the same filesystem, recompute the installed manifest, and prove it is immutable to UID 1027 with traversable ancestors. Preserve 008 unchanged.

The future root orchestrator should use fixed standard-library code, sanitized PATH/CWD/interpreter environment, and exact reviewed bytes. Python helpers run in isolated mode. Node/runtime validators run as UID 1027 from root-protected qualified material, never as root. A root-protected entrypoint with runtime-owned imports is not a protected execution closure. Authenticate artifact retrieval, enforce payload length/SHA256, copy into a private protected parent and rehash before execution.

## 5. Durable maintenance transaction

Use a private root-owned persistent ledger, proposed under `/var/lib/rbridge-maintenance`, with a random transaction ID. `/run` may hold temporary executable/receipt material but cannot be the only reboot/crash record. Ledger updates use exclusive creation or exact compare-and-swap, atomic replacement, file and parent fsync. Retain marker sequence, exact manifests/hashes, observed service/config/pointer identities and gate outcomes; exclude credential values and private environment contents.

Write an intent marker before each state-changing step and a completion marker only after observation. Recovery never infers present state from a marker alone. The most important marker is **START_ATTEMPTED**, durably written and fsynced before invoking the candidate service start. Once present, automatic old restart is refused even if start returned an error or no operation is yet visible. This conservative rule avoids inventing a bootstrap-only proof.

| Phase | Evidence/invariant | Failure or crash outcome |
| --- | --- | --- |
| QUALIFIED / STAGED | Source, artifact, profile and reader fixtures qualified; production untouched | Abort; remove only transaction-owned temporary material |
| PAUSE_INTENT / PAUSED | Old invocation/config/pointer rechecked; all writers/admissions stopped | Re-observe pause; UNKNOWN blocks further changes |
| BACKUP_COMPLETE / GATES_PASS | Verified full backup and all five gates refer to one maintained paused fingerprint | Abort switch; old restoration allowed only with fresh compatibility/CAS checks |
| CONFIG_INTENT / CONFIG_INSTALLED | Exact owned additions; effective precedence/hardening/drop-ins verified | Remove only unchanged owned additions under CAS |
| POINTER_INTENT / POINTER_SWITCHED | Atomic pointer to qualified immutable candidate; no START_ATTEMPTED | Restore old pointer/config only with ownership, unchanged state and fresh offline proof |
| START_ATTEMPTED / NEW_STARTED | Intent durable before start; new invocation/UID/artifact/profile observed | Refuse automatic 008 restart; stop/settle candidate and preserve all evidence |
| ACCEPTING / ACCEPTED | Real transport and actual reader acceptance recorded; no uncertainty hidden | Commit acceptance evidence; failed acceptance uses post-start hold |
| ROLLED_BACK / ROLLBACK_BLOCKED | Old restore proven, or explicit stopped candidate state with reason | Distinct actual exit/status; no blanket trap restart |

Hold one validated root maintenance flock throughout capture, pause, backup/gates, switch, acceptance and recovery. Its stable inode coordinates cooperating procedures; it does not stop other administrators or same-UID writers. Independently prove writer exclusion. Do not delete or replace relay/owner lock inodes. Runtime relay/owner locks are execution exclusion, not installer authorization. An offline validator cannot forge an in-process retained relay-lock guard from another process's descriptor.

Recovery must be idempotent against ledger and current bytes. It may finish or undo only transaction-owned additions whose exact identity/hash still matches. Unknown ownership, pointer/config drift, invalid ledger, fsync uncertainty or unclassified durable changes produce a blocked state with preserved evidence. No recovery action overwrites new state with an old backup.

## 6. Pause, backup and five offline gates

Immediately before maintenance, recapture the actual pointer, old invocation, executable, account, fragment, all drop-ins, original EnvironmentFile hashes and effective settings. Store secret-bearing hashes privately; never print or shell-source those files. Preserve the observed CPUQuota drop-in and all unrelated settings. A historic “no drop-ins” condition is stale.

Stop the main service and any verified alternate legacy writer. Prove inactive service/MainPID zero, empty service cgroup, settled escaped/detached supervisors, closed live admission endpoints and no process writing the relevant state. Respect bounded stop deadlines. A failed shutdown or unresolved detached process blocks all pointer/config actions; a process-name search alone is not writer exclusion.

Maintain the pause through full snapshot, validation and controlled handoff. Back up all records/tombstones/results/stages/journals, FlowPilot history, process claims/specs/logs/receipts, transfer manifests/chunks and metadata. Record unknown entries and classify them; do not silently omit them. Sockets/FIFOs require a specific stopped-state classification and are not generic recursive archive targets. Verify backup bytes/metadata against its manifest and repeat the unchanged live fingerprint. An archive command exit zero is insufficient.

| Gate | PASS requirement | Important implementation constraint |
| --- | --- | --- |
| Legacy | Bounded complete parse, filename/request/phase/digest/scope consistency; authenticated fresh issue identity/body/request correlation; no open trusted unresolved work, identity mismatch or lookup error; preserve closed/unscoped history | Existing V1 auditor covers root JSON and sessions, not all five stores. It permits records up to 2 MiB. Installation correlation must not rely only on title/author/state |
| FlowPilot | Full 192-character ID contract, schema/digest/app/job/callback/tombstone consistency, every record settled COMPLETED, no pending/claim ambiguity, no unreadable/changing record | `get` may unlink a claim; `pending` may compact. They are not read-only offline validators |
| Process/supervisor | Complete linked claims/specs/receipts; only proven settled terminal sessions; no UNCERTAIN/start ambiguity/live matching process or malformed record | `stats` catches and omits load failures; zero HEALTH sessions does not prove this gate |
| Transfers | Complete bounded manifests/chunks, correct path/byte/digest identity; no OPEN or ambiguous transfer, including expired OPEN; preserve all evidence | `stats` omits expired OPEN and ordinary operations can remove expired evidence |
| Core | For first install freshly prove absent. If unexpectedly present, block this first-install transaction; use a separately reviewed read-only existing-Core procedure | Constructors create state and owner recovery changes receipts/reobserves reads. Do not initialize Core to check absence |

For a future existing-Core procedure, validate exact manifest binding and all operation/policy/receipt/output/delivery/stage/accounting objects; zero pending counts is insufficient. This design does not claim that validator already exists. Likewise, new FlowPilot/process/transfer offline validators require implementation and negative qualification before any root command is published.

All gates use the same maintained paused snapshot and bounded authenticated lookup context. Account/repository mismatch, authentication failure, lookup timeout, rate-limit uncertainty or changing request body yields UNKNOWN/BLOCKED. Do not copy credentials into reports. Live inventory, HEALTH counts or a stable PID cannot replace these gates.

A diagnostic initially used a 64 KiB record cap and returned FAIL with partial scope counts. Follow-up metadata inspection identified 200 otherwise valid records exceeding that cap, none above the source auditor's 2 MiB limit. The first FAIL remains archived; a corrected live scope scan only informs identity preparation. It never promotes the full offline gate to PASS.

## 7. Configuration and pointer ownership

Use one reviewed root-owned environment addition and one drop-in that appends it after the existing runtime and FlowPilot EnvironmentFiles. Proposed installation-owned paths are `/etc/rbridge/p2a-binding.env` and `/etc/systemd/system/rbridge.service.d/60-p2a-binding.conf`; refuse any pre-existing unowned path. The environment addition contains only the exact approved explicit principal/target and both release SHA variables: `RBRIDGE_RELEASE_SHA` and `COCWIN_REMOTE_BRIDGE_RELEASE_SHA` equal the candidate SHA. EnvironmentFile precedence must be validated; an earlier `Environment=` assignment is insufficient.

Prepare exact bytes/modes privately in the profile. Install only while paused. Validate effective order, original file hashes, User/Group, ExecStart, hardening, CPUQuota and writable roots after daemon reload. FILE READ needs existing readability of the canary root, not an unsolicited writable-root expansion. Then atomically replace only the verified production symlink with the qualified release, recording old/new identities and fsync evidence.

Before START_ATTEMPTED, restoration removes only exact owned additions and restores only the expected pointer under CAS. It never replaces a whole unit or restores stale environment contents over concurrent edits. Drift blocks restoration. After START_ATTEMPTED, keep candidate pointer/config until a compatible recovery is independently authorized.

## 8. Actual reader compatibility

Current acceptance is **UNKNOWN**. Static investigation identified producer/test/publisher-resume paths and the historical ChatGPT-to-GitHub-comment workflow, but no exact live HEALTH/FILE semantic reader entrypoint, installed version or reader-produced acceptance. Negative indexed search does not prove that external/unindexed clients do not exist. P2A SDK source tests qualify their test clients; an old one-issue APP_RUN reconciliation helper does not qualify Core results.

Register every actual consumer: owner, entrypoint, immutable source/content hash, installed client version and trusted repository/author/runtime/principal/target/policy. Unknown consumers stay UNKNOWN. Invoke the actual named reader against genuine legacy fixtures and pinned Core fixtures. A newly created reference parser qualifies only itself until adopted and identified as the actual reader.

Both legacy SAFE and Core SAFE results use `COCWIN_REMOTE_BRIDGE_RESULT_V2`. First validate which supported envelope branch is present. Legacy BLOCKED/UNCERTAIN envelopes can validly omit both `operationResult` and outer `resultSha256`; correlate their trusted carrier, request and reason without inventing a Core receipt or successful result. When a value exists, dispatch on the inner schema: legacy values are flat `operationResult`; Core values are `RBRIDGE_GITHUB_CORE_RESULT_V1` with `receipt` and optional `output`. HEALTH/FILE data is under `operationResult.output`. A valid BLOCKED/FAIL/UNCERTAIN/TERMINATED Core receipt may omit output; never infer PASS from output presence/absence. Preserve original legacy replay and APP_RUN formats.

| Digest | Required preimage |
| --- | --- |
| Outer request SHA for a successfully parsed/admitted request | Canonical original V2 request, including ID/time/operation |
| Legacy pre-claim malformed/fresh-expired rejection request SHA | SHA256 of the exact raw issue body, as emitted by the pinned legacy worker; validate this branch explicitly rather than accepting either digest indiscriminately |
| Outer result SHA, when operationResult exists | `SHA256(JSON.stringify(operationResult))`, preserving parsed wrapper order; absent in supported legacy no-result BLOCKED/UNCERTAIN envelopes |
| Receipt intent SHA | Canonical `{schema, principalId, targetInstanceId, operation}`; operation ID is separately correlated |
| Receipt result SHA | Canonical complete output bytes, when output exists |
| Chunk SHA | Strictly decoded chunk bytes |
| Manifest object SHA | Compact complete V2-envelope bytes; transfer identity derives from this digest |

Do not substitute these digests or sort the wrapper before checking its outer digest. A digest does not authenticate its carrier. Pin expected repository, issue/comment identity/author, request title/body and applicable scope/intent. Validate a consistent complete chunk set, strict base64, count/indices, duplicate agreement, per-chunk SHA, manifest byte length and whole object SHA before semantic parsing.

| Case | Reader acceptance requirement |
| --- | --- |
| C01 Legacy direct HEALTH/FILE | Trusted carrier/request/result hashes and operation-specific flat result semantics |
| C02 Core direct HEALTH/FILE | Correct wrapper, receipt identity/principal/target/intent/policy/phase/outcome and output |
| C03 Terminal no-output/error | Core BLOCKED/FAIL/UNCERTAIN/TERMINATED and legacy no-operationResult BLOCKED/UNCERTAIN classified accurately; no invented receipt or successful output |
| C04 Large carrier | Complete chunk+manifest assembly; reject missing/conflicting/mixed/corrupt carriers |
| C05 Digest separation | Reject digest substitution and outer-order/canonical-output confusion; distinguish canonical admitted-request SHA from the exact raw-body SHA in legacy pre-claim rejection |
| C06 Trust negatives | Reject wrong author/repository/issue/request/scope and rehashed forged receipts |
| C07 Known expired/closed replay | Preserve original inner receipt/output/snapshot after initial TTL or carrier closure; expected new carrier issue may differ |
| C08 Fresh expired/collision | No fabricated receipt after pre-claim rejection; preserve winning identity and accurate rejection/availability |
| C09 Actual MCP clients | Exact modern/legacy client versions and binding; schema/status/result byte cursors, whole-output digest and UTF-8/JSON; no ambiguous automatic resubmit |

Save fixture and reader hashes, exact invocations, outputs and reader-produced verdicts. All applicable rows must pass before switching; do not replace the gate with producer unit tests or archival hash verification. Install-time acceptance then uses the same identified reader/version.

## 9. Production acceptance and post-start hold

Start only after profile/artifact/readers/backup/five-gate qualification and separate exact production-switch authorization, in an owner-present window. Persist START_ATTEMPTED first. Observe the new invocation, UID/account, executable/artifact path, complete installed manifest, binding and effective service configuration. HEALTH's release SHA is environment metadata; it does not prove executable bytes.

Use predeclared unique, reservation-checked IDs for one real GitHub HEALTH and one bounded nonsensitive FILE READ. Authenticate request/comment author and identity, parse the Core wrapper with the actual reader, verify scope/policy/receipt/outcome and output digests, and independently read back publication/closed state. Compare FILE bytes with the exact canary fixture. Launch MCP from the immutable artifact under the same approved UID/environment; verify capabilities/status/result convergence on the same Core operation IDs. Do not submit another app job, mutating FILE or PROCESS canary.

Bound all polling and preserve ambiguity. A lost acknowledgement is not permission to execute again. Verify original known receipt/output after a controlled candidate restart and after initial TTL/closed-carrier reconciliation; do not obtain a fresh snapshot by new execution. Preserve every original inner digest and receipt. FlowPilot ingress/config is checked without submitting production development work.

If acceptance fails or becomes uncertain, stop the candidate, prove IO/ingress/cgroup settlement, take a full protected post-start snapshot and record **ROLLBACK_BLOCKED_START_ATTEMPTED** with the narrower observed reason where available. Keep candidate pointer/config, both releases, ledger, backup and all new durable/external evidence. Any Core ID, including a closed published read or durable BLOCKED action, reinforces old-restart refusal. New legacy work, pending delivery/FlowPilot/transfer, interrupted mutation, uncertain process, lost lookup and ownership drift also block old restore.

Never restore an old backup over new history, delete Core evidence, synthesize legacy reservations or retry an old job to manufacture a rollback PASS. No bootstrap-only exception is included. Restoring availability after this boundary requires explicit compatible recovery, such as a qualified corrected candidate; it is not an automatic 008 fallback. Acceptance success records the actual installed state and stops maintenance, without claiming future health forever.

## 10. Future qualification and deliverables

The implementation plan must separate: deployment-profile validation; non-root artifact qualification; protected copier; persistent ledger/recovery; complete read-only state validators; configuration/pointer CAS; real reader fixtures; authenticated acceptance; and exact-byte root bootstrap publication. These are future work, not implemented capabilities in this spec.

Qualify meaningful negative/crash fixtures before publishing a sudo command:

- Wrong source/tree/runtime; missing/altered dependency or compiled byte; staging replacement during copy; unsafe ancestor, hardlink, symlink escape, FIFO/socket, unexpected object or root import closure.
- Helper/payload/hash/length/auth-readback mismatch; malformed ledger; failed file/parent fsync; maintenance-lock loss; alternate writers; incomplete stop; backup mismatch or changed paused fingerprint.
- Config/drop-in/CPUQuota/order/invocation drift; pre-existing owned-path conflict; partial daemon reload; pointer CAS loss; power/crash before and after every intent/completion marker.
- Legacy body/digest/identity/lookup errors; closed unscoped preservation; FlowPilot 192-character IDs, pending callbacks/tombstone mismatch/two-link claims without deletion; process records omitted by stats; expired OPEN transfers; unexpected existing Core state.
- Actual-reader old-envelope assumption, false-PASS, forged/rehashed identity, corrupt/missing/conflicting chunks, digest substitution, wrong scope/policy, disconnect/lost ACK and timeout.
- Post-start failure, live IO beyond stop deadline, closed published Core read, durable disabled-action BLOCK, Core ID presented as APP_RUN/FlowPilot, new accepted legacy job, unknown stage and concurrent ownership drift: every case refuses automatic old restart.

Require distinct actual exit/status for accepted installation, precondition UNKNOWN/BLOCKED, verified pre-start old restoration, and stopped post-start rollback refusal. The bootstrap preserves sudo/outer status and the interactive parent shell. No trap may start the wrong release or release exclusion while work remains unsettled.

Deliver the reviewed executable transaction and complete import closure, exact length/SHA manifest, negative/crash evidence, artifact and reader qualification, authenticated artifact publication/readback, private deployment profile, bounded maintenance command and evidence-preserving resume procedure. No runnable root command is ready at this draft stage.

## 11. Review and readiness

The owner reviews this written specification and the proposed private binding. After approval, prepare the Native implementation plan and its concrete tasks. Keep the completed P2A source/plan/final review unchanged. Installer implementation, actual reader identification/adoption, artifact qualification, paused gates and production-switch permission remain separate readiness conditions.

| Condition now | State |
| --- | --- |
| P2A source qualification | PASS for the exact b588 source tree and recorded CI |
| Installation architecture | Written draft prepared; owner review pending |
| Actual downstream readers | UNKNOWN; partial static inventory only |
| Explicit production binding | Proposed privately; not installed/approved |
| Production artifact/installer/validators | Not yet implemented or qualified |
| Maintained paused backup/five gates | Not performed |
| Merge/deploy/sudo | Not performed by this preparation |

Primary source references are `remoteBridgeMain.ts`, `rbridgeOwnerRuntime.ts`, `rbridgeLegacyReservations.ts`, `remoteBridgeStore.ts`, `remoteBridgeWorker.ts`, `remoteBridgeDurableAudit.ts`, `flowPilotBridgeStore.ts`, `remoteBridgeProcessSessions.ts`, `remoteBridgeChunkStore.ts`, the Core journal/result/delivery modules, `rbridgeMcpSafe.ts` and GitHub Core/delivery adapters at the exact candidate above. Immutable private source hashes, bounded live observations, reader inventory limits and the old 008 comparison are retained in the private continuation record rather than published here.
