# P2A Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **The owner has selected Native:** use executing-plans; the primary agent implements the tasks, followed by one fresh whole-branch review. This written plan still requires owner review before implementation.

**Goal:** Build and qualify a crash-aware installation toolkit for the exact P2A runtime, with authenticated reader acceptance and a durable pre-start/post-start recovery boundary.

**Architecture:** Keep the runtime artifact pinned to b588 and build the maintenance toolkit as a separate artifact from its own reviewed commit. Standard-library Python owns privileged copying, ledger, pause/backup, config/pointer CAS and orchestration; qualified Node 22 code runs non-root for complete state validation, carrier parsing and GitHub/MCP acceptance. Only an owner-present, separately authorized maintenance window can start production, after every pre-start gate passes.

**Tech Stack:** Linux/systemd; Node 22.23.2 runtime qualification, existing Node 22 CI and TypeScript/Vitest; Python 3.11+ standard library/unittest, exact host interpreter qualified in the private profile; existing locked dependencies and official MCP client package. Add no package dependency.

**Spec:** [2026-10-05-p2a-installation-design.md](../specs/2026-10-05-p2a-installation-design.md), immutable approved SHA256 `29ff231af52bc5b14b63abf9ba4f6b0027c910cabdc7a827b7365cf9d5164457` at `7365c476f218454ebe43e8fda6a2c4af5bdb2c98`. Owner approved the written spec and the exact private binding on 2026-10-06 00:12:25 Europe/Zagreb. Draft labels inside that preserved spec describe its preparation time; this plan records the subsequent approval.

## Global Constraints

- Runtime source `b5881fd8367b4249e82683f1f884f2392cb696d4`, tree `8eeabd5628c8226bd42c00d79e2f3c37ad252ba8`; old release `008885e07394f20746f034cbd7fe52c6b520533d` stays intact. Toolkit commits never silently replace the runtime source pin.
- Production OS authority is UID/GID 1027 with verified real/effective UID, account/home/groups. Explicit principal/target and trusted repository/author/adapter subjects use the approved private binding; do not publish its coordinates or rotate IDs per client/canary.
- Preserve absent legacy scope. Old 008 had no scoped instance identity. Repository/author drift must be refused independently of the Core manifest.
- PROCESS and Core mutating FILE capabilities remain disabled; APP_RUN stays legacy. No app-job, mutating FILE or PROCESS acceptance canary; no policy-root/credential/HTTP/continuity migration changes.
- Candidate starts ordinary admission; no canary-only fence exists. Persist/fsync START_ATTEMPTED before start; any attempted start blocks automatic 008 restart, including failed startup, closed read IDs and durable BLOCKED receipts.
- Root never builds packages, executes runtime-owned helpers/imports or runs Core validators. Root uses its complete protected stdlib closure; Node validators/readers use the qualified absolute executable under the non-root account.
- Preserve the complete existing config/drop-in set, including runtime CPUQuota. New EnvironmentFile is appended after runtime/FlowPilot files; both release SHA variables equal the runtime pin.
- One maintained pause binds backup and five gates. First-install Core must freshly be absent; unexpected Core is BLOCKED, not initialized or recovered by a validator.
- Runtime factories/get/stats/recovery are not offline validators. Unknown entries, parse/load failure, pending claims, expired OPEN transfers, unresolved writers and lookup uncertainty cannot produce PASS.
- Actual-reader acceptance is UNKNOWN until the registered reader itself produces C01–C09 evidence. A reference parser or source test does not prove adoption; modern/legacy MCP negotiation modes are not automatically different installed package versions.
- Keep source tests, toolkit/artifact qualification, privileged fixture tests, genuine reader fixtures, and installed production acceptance as separate evidence classes. Do not skip UID/runtime failures or convert Native UID0/Node24 tests into positive runtime proof.
- Only Remote Bridge/Cocwin workflows access the host. No SSH/Desktop Commander fallback. No root command publication before its exact bytes/import closure and prerequisite qualifications are reviewed.

## Review Focus

1. A staged ancestor/object is replaced during copying: publication must fail without following the replacement or modifying an existing release; pin real descriptor-race tests in Task3.
2. A power loss or partial daemon reload occurs between intent and completion: resume must reconcile actual bytes, preserve concurrent changes and never start 008 after START_ATTEMPTED; pin crash fixtures in Tasks4/13/14.
3. A completed historical record hides a two-link claim, malformed session or expired OPEN transfer: full inventory must block and leave every byte/name/link unchanged; pin Tasks5/7/8/9.
4. An authentic legacy error has no operationResult and a raw-body request digest, or a forged Core result is rehashed: the actual reader must classify the former accurately and reject the latter; pin Tasks11/12.
5. A start/stop acknowledgement is lost while new work or IO may exist: preserve the original operation and exclusion, report uncertainty, and refuse old restart even for closed published reads; pin Tasks14/15.

## Scope, artifacts and execution

This is one installation subsystem with separately testable components, not a new runtime feature programme. Implement in a new isolated branch from this documentation snapshot. The completed P2A13-task ledger/frozen contract/design/plan and final source review are not reopened. Do not implement in main, the approved b588 worktree, or the documentation branch used to publish this plan.

Use two manifests: `RBRIDGE_INSTALL_ARTIFACT_V1` for the unchanged runtime and `RBRIDGE_INSTALL_TOOLKIT_V1` for the future toolkit. The toolkit packages compiled validators/readers and their required locked dependency/import closure separately from the runtime release. Root Python imports only manifest-qualified files inside its protected toolkit package. Helper, runtime and toolkit SHA fields are distinct throughout.

All test steps below describe **future RED/GREEN evidence**, not tests executed while writing this plan. Native implements all16 tasks itself. A fresh most-capable available reviewer checks the whole installation branch once after required checks; resolve material findings with one bounded regression-first pass. Planning input inventories are not task reviews or another P2A review.

## File map

| Files to create | Responsibility |
| --- | --- |
| `ops/install/rbridge_installation/{__init__,models,profile}.py` | Shared strict profile/report schemas and fixed deployment pins |
| `ops/install/rbridge_installation/{artifact,protected_copy}.py` | Artifact inventory/hash validation and descriptor-safe immutable publication |
| `ops/install/rbridge_installation/{ledger,pause_backup}.py` | Persistent intent ledger, actual-state reconciliation, writer pause and complete snapshot/backup |
| `ops/install/rbridge_installation/{github_lookup,configuration}.py` | Bounded authenticated body lookups; effective-config/pointer CAS |
| `ops/install/rbridge_installation/{transaction,acceptance,qualification}.py` | Phase orchestration, real-transport evidence and qualification bundle |
| `ops/install/{rbridge_install.py,rbridge_bootstrap.py,run_installation_tests.py}` | Fixed CLI, standalone protected bootstrap and stdlib test runner |
| `src/installation/{types,readonlySnapshot,legacyGate,flowPilotGate,processGate,transferGate,firstInstallGate}.ts` | Non-root read-only snapshot and five state gates |
| `src/installation/{carrierJson,githubCarrierReader,readerQualification,artifactQualification}.ts` | Strict raw JSON/carrier consumer, actual-reader qualification and isolated final-artifact fixture |
| `src/cli/{rbridgeInstallationAudit,rbridgeReadResult,rbridgeInstallationAccept}.ts` | Fixed, bounded maintenance entrypoints; no request-controlled executable |
| `tests/install/{_loader,_fixtures,test_profile,test_artifact,test_copy,test_ledger,test_pause_backup,test_lookup,test_configuration,test_transaction,test_acceptance,test_bootstrap}.py` | Stdlib policy/IO/race/crash fixtures; distinguish abstract tests from privileged qualification |
| `tests/installation/{readonly-snapshot,legacy-gate,flowpilot-gate,process-gate,transfer-gate,first-install-gate,github-carrier-reader,reader-qualification,artifact-qualification}.test.ts` | Complete validator/reader negatives and qualified non-root fixtures |
| `tests/fixtures/{rbridge-installation-state,rbridge-installation-reader,rbridge-installation-client}.ts` | Synthetic fixtures and real process/SDK harnesses |
| `docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json` | Exact cross-language schema used by strict Python and TypeScript validation |

Modify only `package.json` scripts, `.github/workflows/local-first-ci.yml`, and scoped `docs/INSTALLATION.md`/`docs/OPERATIONS.md` instructions as needed for toolkit verification. These edits do not alter the separately pinned runtime artifact. Keep existing runtime factories, policy and four frozen P2A files unchanged.

## Shared interfaces and bounds — Task1 owns these definitions

Python frozen dataclasses in `models.py` mirror the JSON schema; validators reject missing/extra fields. `Profile` has `binding: Binding`, `runtime: RuntimePins`, `toolkit: ToolkitPins`, `tools: tuple[ToolPin,...]`, `paths: InstallPaths`, `service: ServicePin`, `budget: Budget`, `readers: tuple[ReaderRegistration,...]`. The nested fields are:

- `Binding(uid:int,gid:int,supplementary_gids:tuple[int,...],account:str,home:str,principal_id:str,target_instance_id:str,repository:str,author:str,mcp_subject:str,github_subject:str,policy_sha256:str)`; exact supplementary groups are freshly observed and qualified, never assumed from the account label.
- `RuntimePins(source_sha:str,tree_sha:str,old_sha:str,node_path:str,node_version:str,node_sha256:str,npm_cli_path:str,npm_sha256:str,lock_sha256:str,manifest_sha256:str)`.
- `ToolkitPins(source_sha:str,manifest_sha256:str,python_path:str,python_version:str,python_sha256:str)`; no root import outside its qualified package and stdlib.
- `ToolPin(role:str,path:str,sha256:str,version:str)` for fixed host tools such as systemctl, authenticated gh and the identity-switch utility; roles have fixed argument templates, not arbitrary request-supplied commands.
- `InstallPaths(state_root:str,release_parent:str,current_link:str,ledger_parent:str,lock_path:str,binding_env:str,binding_dropin:str,canary_path:str)`.
- `ServicePin(unit:str,alternate_units:tuple[str,...],identity_sha256:str,environment_files:tuple[PathDigest,...],dropins_sha256:str,canary_sha256:str)` with `PathDigest(path:str,sha256:str)` in effective EnvironmentFile order; secret-bearing values never serialized in reports.
- `ReaderRegistration(reader_id:str,source_sha256:str,entrypoint:str,version:str,transport:str,trusted_context_sha256:str,qualification_sha256:str,adoption_sha256:str)`; empty/missing adoption is UNKNOWN.

`Budget` fixes profile defaults: state entries40,000, depth64, bytes64GiB; artifact entries100,000/depth128/bytes1GiB; JSON record2,097,152 bytes; process NDJSON64MiB and at most1,048,576 nonempty frames; carrier capture64MiB/4,096 comments/comment65,536 bytes/complete object8,519,680 bytes; scan600,000ms; each lookup15,000ms,25 issues/batch, response2MiB, lookup overall600,000ms; stop30,000ms; acceptance180,000ms, canary TTL120,000ms, poll1,000ms; global maintenance1,200,000ms. A changed budget requires a reviewed profile and qualification, never an implicit widening after FAIL. Overflow/incomplete inventory is UNKNOWN/BLOCKED. The global deadline blocks beginning a phase without its remaining budget; START_ATTEMPTED requires at least acceptance+stop time reserved. Settlement/evidence preservation is not cut short to satisfy a deadline; an unresolved foreground handoff can exceed the planned window. Deadlines do not authorize early lock release or killing unrelated processes.

Cross-language schema names are `RBRIDGE_P2A_INSTALL_PROFILE_V1`, `RBRIDGE_INSTALL_ARTIFACT_V1`, `RBRIDGE_INSTALL_TOOLKIT_V1`, `RBRIDGE_INSTALL_SNAPSHOT_V1`, `RBRIDGE_INSTALL_GATE_V1`, `RBRIDGE_INSTALL_READERS_V1`, `RBRIDGE_INSTALL_LEDGER_V1`, `RBRIDGE_INSTALL_ACCEPTANCE_V1`, `RBRIDGE_INSTALL_QUALIFICATION_V1`. JSON uses integers only for safe bounded counts; nanosecond times/device/inode values are decimal strings. Canonical evidence JSON is UTF-8, recursively key-sorted, no whitespace, no floats, arrays preserve order. Inventory entries sort by encoded relative-name bytes; raw names are retained as base64 for fingerprinting.

`SnapshotToken` has `transaction_id`, `state_root_identity_sha256`, `tree_sha256`, `entries`, `bytes`, `pause_sha256`, `captured_at`; `GateReport` has `gate`, `status:PASS|BLOCKED|UNKNOWN|FAIL`, `snapshot_sha256` (SHA256 of canonical token), `evidence_sha256`, `checks:Check[]`, `reason_codes:string[]`. A `Check` has `name,status,evidence_sha256?`; no raw secrets. `GateBundle` has `status:PASS|BLOCKED|UNKNOWN|FAIL`, `reason_codes:string[]`, exactly LEGACY,FLOWPILOT,PROCESS,TRANSFERS,CORE reports and the shared token; PASS requires all five matching PASS reports. `TransactionResult` has `status`, `exit_code`, `phase`, `ledger_sha256`, `reason_codes`; root CLI exits0 accepted,2 precondition/UNKNOWN,3 verified pre-start restoration,4 proven stopped post-start refusal,5 definite qualification/validation FAIL.

TS counterparts live in `types.ts` with strict parsers. `ReadonlySnapshot` exposes `token`, `entries`, `read(relativePath,maxBytes):Promise<Uint8Array>`, `assertUnchanged():Promise<void>`, `close():Promise<void>` and never mutates state. `GateContext` contains the verified profile, snapshot and authenticated `IssueEvidence[]`; `IssueEvidence` contains number/state/title/body/author/url/isPullRequest/updatedAt and qualified capture digest. `ProcessObservation` contains examined PID/start-time identity, cgroup membership and settlement verdict. Python passes qualified JSON through fixed CLI arguments/stdin, never shell source/eval.

Additional boundary types are defined by their owning task and included in the shared schema: `ArtifactManifest(kind,source_sha,tree_sha,node_sha256,entries,sha256)` and `ArtifactProof(manifest_sha256,observed_sha256,source_sha,node_sha256,status)`; entries carry relative path/type/size/mode/UID policy/SHA or confined link target. `PublishedArtifact` adds exact installed path and post-publication proof. `LedgerEntry(sequence,marker,previous_sha256,evidence,sha256)`/`LedgerSnapshot(entries,sha256)` are append-only evidence; `RecoveryDecision(action,may_start_old,reason_codes)` uses the five named actions. `OwnedConfigChange`/`OwnedPointerChange` carry prior/current bytes or link identity, expected hashes and transaction ownership; `OwnedChanges` groups both. `RestoreProof` binds actual restored identities, fresh gates and `may_start_old`, which can be true only before START_ATTEMPTED with verified restoration. `PreparedInstallation(profile_sha256,runtime_proof,toolkit_proof,reader_proof,qualification_sha256)` and `SwitchAuthorization(profile_sha256,runtime_sha256,toolkit_sha256,bootstrap_sha256,owner_present,approved)` are distinct. `OwnerCommand(status:READY|BLOCKED,payload?,payload_sha256?,reason_codes)` cannot contain an executable payload when blocked. `ProfileError`, `ArtifactError`, `CopyError`, `PauseError`, `ConfigError` and `BootstrapError` share a sanitized stable reason-code base.

`HostBackend` names fixed methods `observe_service(profile)`, `observe_writers(profile)`, `stop_approved_units(profile)`, `start_candidate(profile)`, `start_old(profile)`, `daemon_reload(profile)`, `observe_processes(profile)`; no caller supplies an executable or shell command. Observation types retain invocation/PID-start/cgroup/endpoint/profile fingerprints and status. Qualification/acceptance input types explicitly carry the profiles, exact manifests, isolated-state root, registered readers, fixture hashes and deadlines described in Tasks2/12/15/16; their output reports carry status plus those input digests. Test backends implement these same methods and never count as live host observation.

### Task1: Strict profile, shared reports and test entrypoint

**Files:** Create the shared models/profile/types/schema, `_loader.py`, `_fixtures.py`, `test_profile.py`, `run_installation_tests.py`. Modify CI and package scripts only to add `verify:installation` = `python3 -I -B ops/install/run_installation_tests.py`.

**Interfaces:** Consumes approved spec/private profile inputs. Produces the types above, `parse_profile(value:object)->Profile`, `parseRBridgeInstallProfile(value:unknown):InstallProfile`, `load_toolkit(package_root:Path)->ModuleType` for tests, and strict report serialization/digests. The test loader imports only the explicitly located package; production root bootstrap uses a separately verified closure.

- [ ] **Step1 — RED:** Add `test_profile_rejects_identity_pin_or_extra_field` and schema roundtrip fixtures.

```python
with self.assertRaises(ProfileError): parse_profile(profile_with(uid=0))
with self.assertRaises(ProfileError): parse_profile(profile_with(node_version='24.0.0'))
self.assertEqual(parse_profile(valid_profile()).runtime.source_sha, RUNTIME_SHA)
self.assertEqual(encode_report(report()).decode(), node_encoded_report_fixture())
```

- [ ] **Step2 — Confirm RED:** `python3 -I -B -m unittest discover -s tests/install -p test_profile.py -v`; missing shared implementation fails, not a skipped test.
- [ ] **Step3 — Implement:** Define every named model/TS counterpart and strict parser; pin runtime/old SHA, explicit binding syntax/subject mapping, safe absolute paths, approved modes and bounds. Add the isolated loader/runner and CI Python3.11+ version check plus `npm run verify:installation`; use current non-root runner, no dependency install.
- [ ] **Step4 — GREEN:** Same targeted command and `npm run verify:installation`; TS cross-language golden fixture checks canonical bytes. Keep real privileged qualification pending.
- [ ] **Step5 — Commit:** `feat(install): define strict deployment profile and evidence contracts` with only Task1 files.

### Task2: Final runtime/toolkit artifact manifests and non-root qualification

**Files:** Create `artifact.py`, `artifactQualification.ts`, `artifact-qualification.test.ts`, `test_artifact.py`; extend `_fixtures.py`.

**Interfaces:** Consumes Profile/schema. Produces `inventory_artifact(root:Path,kind:str,profile:Profile)->ArtifactManifest`, `verify_artifact(root:Path,manifest:ArtifactManifest)->ArtifactProof`, `qualifyRBridgeArtifact(input:ArtifactQualificationInput):Promise<ArtifactQualificationReport>`. Input includes manifest, qualified Node path and isolated durable state; output binds exact artifact/Node/source digests and fixture receipts.

- [ ] **Step1 — RED:** `test_artifact_rejects_missing_dependency_after_prune`; non-root fixture `final artifact boots owner and MCP using shipped dependencies`.

```python
before = inventory_artifact(stage, 'RUNTIME', profile)
remove_required_module(stage)
with self.assertRaises(ArtifactError): verify_artifact(stage, before)
self.assertNotEqual(before.sha256, toolkit_manifest.sha256)
```

- [ ] **Step2 — Confirm RED:** Python `test_artifact.py`; `npm test -- tests/installation/artifact-qualification.test.ts`.
- [ ] **Step3 — Implement:** Non-root build exact b588 with qualified Node22.23.2, `npm ci --ignore-scripts --no-audit --no-fund`, existing required checks and build. Create final runtime production-only dependency stage, then manifest every package/compiled/import/dependency/map byte and confined symlink. Toolkit uses its own exact source pin/import/dependency manifest and includes the already locked client SDK/transitive closure needed by its acceptance entrypoint; do not omit it merely because it is a development dependency of the source checkout. Bind a real non-root isolated boot/IPC/MCP fixture to the final material, not build-tree `tsx` or undeclared stage dependencies. Missing/modified bytes, special files, hard links, escaping links or wrong runtime fail.
- [ ] **Step4 — GREEN:** Targeted suites; real final-artifact fixture on qualified Node22.23.2/non-root persistent ext4-compatible state. Save artifact proof separately from b588 CI and any Python abstraction tests.
- [ ] **Step5 — Commit:** `feat(install): qualify complete runtime and toolkit artifacts`.

### Task3: Protected root publication without staging races

**Files:** Create `protected_copy.py`, `test_copy.py`; extend artifact fixtures.

**Interfaces:** Consumes Profile/ArtifactManifest/proof. Produces `publish_artifact(stage_fd:int,parent_fd:int,manifest:ArtifactManifest,authority:FilesystemAuthority)->PublishedArtifact` and `verify_published(path:Path,manifest:ArtifactManifest)->ArtifactProof`. `FilesystemAuthority` pins expected root/runtime UID, ownership/modes and fixed destination role; production root guard always requires UID0. Fixture authority abstraction is not privileged production proof.

- [ ] **Step1 — RED:** `test_copy_parent_swap_never_publishes_replacement`, `test_copy_rejects_existing_release_or_escaping_link`.

```python
inject_parent_swap_during_open()
with self.assertRaises(CopyError): publish_fixture()
self.assertEqual(existing_release_hash(), old_hash)
self.assertFalse(candidate_release_exists())
```

- [ ] **Step2 — Confirm RED:** Python `test_copy.py`; real swap synchronization uses pipe/barrier, not arbitrary sleeps.
- [ ] **Step3 — Implement:** Open ancestors/files through no-follow descriptors, compare before/after identities, copy allowlisted bytes to exclusive root-owned temporary directory, rehash, fsync and same-filesystem rename. Handle explicitly confined relative symlinks without recursively following them. Refuse pre-existing destination, unmanifested data, hardlink/FIFO/socket/setuid and foreign/writable protected parent. Publish runtime and toolkit independently; never chown then execute the stage.
- [ ] **Step4 — GREEN:** Targeted descriptor races and unchanged-old-release assertions. Later bounded root-only fixture qualification in a protected temporary parent is mandatory; no unit abstraction is presented as UID0 publication proof.
- [ ] **Step5 — Commit:** `feat(install): publish immutable artifacts through verified descriptors`.

### Task4: Persistent intent ledger and conservative recovery decisions

**Files:** Create `ledger.py`, `test_ledger.py`.

**Interfaces:** Consumes Profile/report schemas. Produces `open_ledger(parent_fd:int,transaction_id:str)->Ledger`, `Ledger.append(marker:str,evidence:Mapping)->LedgerEntry`, `Ledger.read()->LedgerSnapshot`, `recovery_decision(ledger:LedgerSnapshot,observed:ObservedTransactionState)->RecoveryDecision`. `ObservedTransactionState` contains current pointer/config/service/snapshot identities; `RecoveryDecision` is CONTINUE_PRE_START, RESTORE_OWNED_PRE_START, HOLD_POST_START, HOLD_UNSETTLED or BLOCKED_DRIFT.

- [ ] **Step1 — RED:** `test_start_intent_survives_failed_start_and_forbids_old_restore`, `test_fsync_failure_never_advances_marker`.

```python
ledger.append('START_ATTEMPTED', evidence)
decision = recovery_decision(reopen_ledger(), observed_start_error())
self.assertEqual(decision.action, 'HOLD_POST_START')
self.assertFalse(decision.may_start_old)
```

- [ ] **Step2 — Confirm RED:** Python `test_ledger.py`, including actual child-process termination between marker writes.
- [ ] **Step3 — Implement:** Root-private persistent ledger under approved `/var/lib/rbridge-maintenance` parent; random32hex transaction ID, sequence/previous digest, strict fields, exclusive/CAS atomic writes and file/parent fsync. Intent precedes every config/pointer/start step; completed markers follow observation. Refuse malformed sequence, partial replacement, fsync uncertainty or ownership drift. Reconstruct decisions from actual state, never marker alone; no bootstrap-only exception.
- [ ] **Step4 — GREEN:** Crash before/after each marker and corruption/replace fixtures. Preserve ledger after failure/reboot; do not delete it on EXIT.
- [ ] **Step5 — Commit:** `feat(install): persist phase intents and fail-closed recovery decisions`.

### Task5: Maintained pause, complete snapshot and verified backup

**Files:** Create `pause_backup.py`, `readonlySnapshot.ts`, `readonly-snapshot.test.ts`, `test_pause_backup.py`, `rbridge-installation-state.ts`.

**Interfaces:** Consumes Profile/Ledger. Produces `capture_service(profile:Profile,backend:HostBackend)->ServiceObservation`, `maintain_pause(profile:Profile,backend:HostBackend,ledger:Ledger)->PauseLease`, `capture_snapshot(lease:PauseLease)->SnapshotManifest`, `backup_snapshot(snapshot:SnapshotManifest,parent_fd:int)->BackupProof`; TS `openReadonlySnapshot(profile:InstallProfile,token:SnapshotToken):Promise<ReadonlySnapshot>`. `HostBackend` exposes fixed qualified executable observations/systemctl actions; `PauseLease` owns maintenance-lock FD, pause evidence and explicit settlement state.

- [ ] **Step1 — RED:** `test_unsettled_cgroup_or_alternate_writer_blocks_snapshot`, `test_backup_preserves_two_link_evidence_and_unknown_names`; TS `snapshot mutation is detected and no read changes tree`.

```python
with self.assertRaises(PauseError): maintain_pause(profile, backend_with_live_writer(), ledger)
self.assertEqual(before_tree(), after_failed_backup_tree())
self.assertFalse(backend.old_start_called)
```

- [ ] **Step2 — Confirm RED:** Python `test_pause_backup.py`; `npm test -- tests/installation/readonly-snapshot.test.ts`.
- [ ] **Step3 — Implement:** Capture effective fragment/drop-ins/CPUQuota/EnvironmentFile hashes/invocation privately, then fixed approved unit stop. Verify zero MainPID, inactive service, empty cgroup, detached supervisor identity and admission closure; unknown same-UID/alternate writer classification blocks. Maintained coordination plus kernel observations and repeated fingerprint are required; unchanged bytes alone do not prove exclusion. Descriptor inventory classifies every name/object, preserves internal hardlink groups, and records approved stopped sockets as metadata without copying active endpoints. Unknown/FIFO/unexplained stage blocks gate; nothing is removed. Backup full tree bytes/metadata/link groups and verify manifest before/after. Stable fingerprints include names, bytes, type, UID/GID/mode/nlink/dev/inode/mtime/ctime; exclude access time that the OS may update during reads, preserve captured access time in backup, and never write the original merely to restore it. ReadonlySnapshot uses qualified descriptor helpers, complete inventory and strict budgets, never ensureDirectory/chmod/store get/stats.
- [ ] **Step4 — GREEN:** Exact byte/name/UID/mode/nlink/mtime/ctime fingerprints before/after all validator fixtures; backup mismatch, unsafe object, changed pause and deadline negatives. First-install Core observation does not create a directory.
- [ ] **Step5 — Commit:** `feat(install): bind full backup to a maintained writer pause`.

### Task6: Full legacy gate with authenticated body correlation

**Files:** Create `legacyGate.ts`, `legacy-gate.test.ts`, `github_lookup.py`, `test_lookup.py`.

**Interfaces:** Consumes GateContext/ReadonlySnapshot. Produces `auditLegacyGate(context:GateContext):Promise<GateReport>` and `lookup_issues(profile:Profile,numbers:Sequence[int],backend:GitHubReadBackend)->tuple[IssueEvidence,...]`. Backend uses a fixed read-only GraphQL query through qualified `gh`, expected viewer/repository/author and bounded25-issue batches; neither query text nor executable comes from requests.

- [ ] **Step1 — RED:** `legacy 65537-byte and 2MiB records remain valid but larger records block`, `closed unscoped history is preserved`, `changed body or lookup omission cannot pass`.

```ts
expect((await auditLegacyGate(closedUnscopedFixture())).status).toBe('PASS');
expect(await fixtureTreeDigest()).toBe(before);
expect((await auditLegacyGate(bodyChangedFixture())).status).toBe('BLOCKED');
```

- [ ] **Step2 — Confirm RED:** TS legacy suite and Python `test_lookup.py`.
- [ ] **Step3 — Implement:** Strict full record/result shape, filenames, request/job/scope digest and timestamp checks using immutable source semantics; preserve absent scope. Correlate every retained issue identity/body/request digest using authenticated fresh bounded evidence, including published rows; reuse lookup evidence for duplicate issue numbers. Do not reinterpret legitimate legacy raw-body rejection as canonical admitted-request digest. No title-only match. Open trusted unresolved work blocks; verified closed historical unresolved rows stay preserved under the specified gate. Missing/changed lookup, auth mismatch, rate-budget uncertainty or parser failure yields UNKNOWN/BLOCKED. Validate GraphQL errors/nulls/PR identity, body64KiB and response2MiB; retain rate-limit observations without assuming unlimited quota.
- [ ] **Step4 — GREEN:** Targeted parse/digest and batching fixtures; deadline/partial batch/cost exhaustion never returns partial PASS. `auditRemoteBridgeDurableState` may be a comparison oracle for its covered subset, not the whole gate implementation.
- [ ] **Step5 — Commit:** `feat(install): correlate complete legacy history without mutation`.

### Task7: Full FlowPilot gate without claim repair or compaction

**Files:** Create `flowPilotGate.ts`, `flowpilot-gate.test.ts`; extend state fixtures.

**Interfaces:** Consumes GateContext. Produces `auditFlowPilotGate(context:GateContext):Promise<GateReport>`. Use pure `flowPilotOperationDigest`/`flowPilotAppIdentity`; never instantiate store/gateway/runtime.

- [ ] **Step1 — RED:** `192-character completed identity passes`, `193-character ID rejects`, `two-link claim and disagreeing tombstone block unchanged`.

```ts
expect((await auditFlowPilotGate(completedFixture({idLength:192}))).status).toBe('PASS');
expect((await auditFlowPilotGate(twoLinkClaimFixture())).status).toBe('BLOCKED');
expect(await fixtureTreeDigest()).toBe(before);
```

- [ ] **Step2 — Confirm RED:** `npm test -- tests/installation/flowpilot-gate.test.ts`.
- [ ] **Step3 — Implement:** Complete `.json`/`.done`/`.claim`/stage enumeration, strict persisted/tombstone fields, operation digest/app/job mapping, canonical timestamps, loopback callback URL and phase/callback relation. Require COMPLETED records and consistent coexisting tombstones. Validate callback operation/fence/outcome/error and action-specific evidence fields as emitted by pinned gateway; compare expected policy/app/job/action and outcome flags. Retained result SHA is an evidence identifier, not a claimed verification of missing controller-result bytes; report preimage verification separately when bytes are available. Unknown callback semantics or interrupted claims block; never unlink or compact.
- [ ] **Step4 — GREEN:** Pending/fence/evidence/tombstone/foreign-mode/unreadable negatives and complete unchanged tree assertions. Historical FAIL/BLOCKED outcome is not rewritten to PASS merely because a record is settled.
- [ ] **Step5 — Commit:** `feat(install): validate settled FlowPilot history without repair`.

### Task8: Complete process/supervisor settlement gate

**Files:** Create `processGate.ts`, `process-gate.test.ts`; extend state fixtures.

**Interfaces:** Consumes GateContext plus qualified `ProcessObservation[]` from HostBackend. Produces `auditProcessGate(context:GateContext,observations:readonly ProcessObservation[]):Promise<GateReport>`; pure same-process-identity comparison may be reused, no supervisor connection/reconcile calls.

- [ ] **Step1 — RED:** `malformed record cannot hide behind stats zero`, `CLAIMED action receipt and live matching PID block`, `decoded output bytes differ from NDJSON length`.

```ts
expect((await auditProcessGate(malformedSessionFixture(), [])).status).not.toBe('PASS');
expect((await auditProcessGate(claimedReceiptFixture(), settledObservations)).status).toBe('BLOCKED');
expect((await auditProcessGate(validDecodedLogFixture(), settledObservations)).status).toBe('PASS');
```

- [ ] **Step2 — Confirm RED:** Process gate targeted suite.
- [ ] **Step3 — Implement:** Bidirectional claim/spec/record/profile/session/path identity; exact32hex session names; all receipts DONE, only SUCCEEDED/FAILED/TERMINATED with proven process/cgroup settlement. UNCERTAIN, orphan claim/spec, wrong PID start identity and missing observation block. Strict NDJSON/frame/base64 and decoded byte sum against outputBytes/profile limits; log length is not decoded size. Classify stopped control sockets and stages explicitly; never treat unreadable output as empty or call stats/status/readOutput. No process launch/terminate canary.
- [ ] **Step4 — GREEN:** Unknown spec paths, corrupt base64, orphan claim, empty/missing log mismatch, uncertain/truncated history and live identity fixtures; unchanged bytes/metadata on each outcome.
- [ ] **Step5 — Commit:** `feat(install): prove full process history is settled`.

### Task9: Complete transfer gate including expired OPEN state

**Files:** Create `transferGate.ts`, `transfer-gate.test.ts`.

**Interfaces:** Consumes GateContext. Produces `auditTransferGate(context:GateContext):Promise<GateReport>` using pinned main defaults40,000 bytes/chunk,8,000,000 total,256 chunks. A differently configured historical object is UNKNOWN pending an explicit qualified profile, not silently accepted at legal maxima.

- [ ] **Step1 — RED:** `expired OPEN is blocked without deletion`, `complete transfer requires exact directory and all chunk bytes`.

```ts
expect((await auditTransferGate(expiredOpenFixture())).status).toBe('BLOCKED');
expect(await fixtureTreeDigest()).toBe(before);
expect((await auditTransferGate(extraChunkFixture())).status).not.toBe('PASS');
```

- [ ] **Step2 — Confirm RED:** Transfer gate targeted suite.
- [ ] **Step3 — Implement:** Strict manifest/timestamp/count/index/size schema, directory SHA256(UTF8 transferId), exact file set, every chunk size/SHA, total and whole-object SHA, COMPLETE state. Missing manifest/chunk, extra chunk, pending stage, unsorted/conflicting metadata, special object and any OPEN (expired or current) block; never call expiry/finalize/stats operations.
- [ ] **Step4 — GREEN:** Wrong-directory, missing/extra/mixed/corrupt chunk and byte/deadline fixtures; no expiry cleanup occurs.
- [ ] **Step5 — Commit:** `feat(install): validate every transfer without expiry cleanup`.

### Task10: First-install Core absence and one shared five-gate bundle

**Files:** Create `firstInstallGate.ts`, `first-install-gate.test.ts`, `rbridgeInstallationAudit.ts`.

**Interfaces:** Consumes the four gate functions and shared context. Produces `auditFirstInstallCore(context:GateContext):Promise<GateReport>`, `validateFirstInstallGateBundle(reports:readonly GateReport[],token:SnapshotToken):GateBundle`, `collectFirstInstallGates(context:GateContext,observations:readonly ProcessObservation[]):Promise<GateBundle>`, fixed CLI `rbridgeInstallationAudit` reading one bounded profile/token/evidence input and emitting one bundle.

- [ ] **Step1 — RED:** `only genuinely absent Core passes`, `five PASS reports from different tokens do not pass bundle`.

```ts
expect((await auditFirstInstallCore(coreAbsentFixture())).status).toBe('PASS');
expect((await auditFirstInstallCore(emptyCoreDirectoryFixture())).status).toBe('BLOCKED');
expect(validateFirstInstallGateBundle(mixedSnapshotReports, token).status).not.toBe('PASS');
```

- [ ] **Step2 — Confirm RED:** First-install gate suite and fixed CLI fixture.
- [ ] **Step3 — Implement:** Descriptor absence check that rejects directory/file/symlink/dangling object. Do not construct journal/owner. Run all validators against the same maintained pause/token and assert full snapshot unchanged before/after; aggregate PASS only if all five exact gates pass. Include every failure reason without partial-success status. Root invokes the qualified toolkit CLI under actual non-root identity, with sanitized environment and bounded output; schema/digest/token mismatches are UNKNOWN.
- [ ] **Step4 — GREEN:** Core object variants, mixed token, changed state/pause, output truncation and forged/missing report negatives. No existing-Core migration procedure is implemented.
- [ ] **Step5 — Commit:** `feat(install): bind first-install gates to one paused snapshot`.

### Task11: Strict GitHub carrier reader and retained legacy error branches

**Files:** Create `carrierJson.ts`, `githubCarrierReader.ts`, `github-carrier-reader.test.ts`, `rbridge-installation-reader.ts`.

**Interfaces:** Consumes authenticated `CarrierCapture` (issue identity/title/body plus complete comment identities/bodies and capture context digest), expected `ReaderExpectation` (request/scope/intent/policy/source bindings and digest branch). Produces `parseRBridgeCarrierJson(raw:Uint8Array,limit:number):unknown` and `readRBridgeGitHubCarrier(capture:CarrierCapture,expected:ReaderExpectation):ReaderResult`; ReaderResult discriminates LEGACY_RESULT, LEGACY_REJECTION, CORE_RESULT, UNAVAILABLE/INVALID with original receipt/output/carrier evidence and no inferred PASS.

- [ ] **Step1 — RED:** `fresh-expired legacy raw-body BLOCKED lacks operationResult`, `rehashing forged author or scope does not authenticate`, `large carrier rejects missing/conflicting chunks`.

```ts
expect(readRBridgeGitHubCarrier(legacyRawBodyBlocked(), expectation).kind).toBe('LEGACY_REJECTION');
expect(readRBridgeGitHubCarrier(rehashedWrongAuthor(), expectation).kind).toBe('INVALID');
expect(readRBridgeGitHubCarrier(missingChunk(), expectation).kind).toBe('INVALID');
```

- [ ] **Step2 — Confirm RED:** Reader targeted suite with direct/chunk fixture source-bound to b588 producer behavior.
- [ ] **Step3 — Implement:** Trust issue/comment repository/URL/author/request capture first. Preserve legacy no-result BLOCKED/UNCERTAIN and explicitly select canonical admitted-request versus raw-body pre-claim rejection by pinned protocol/reason context. Validate Core receipt scope/intent/policy/terminal outcome and optional output, outer JSON.stringify digest without sorting wrapper, canonical output digest independently. Strictly decode chunks, require complete consistent set/count/indices/duplicates, manifest size/object SHA and transfer ID. Enforce b588 carrier chunk40,000, direct threshold60,000, source Core output limit8,388,608 and complete envelope cap8,519,680. Strict raw JSON validation detects duplicate keys before JSON.parse; identity/count/length fields must be safe integers. Preserve producer JSON.stringify numeric semantics and raw capture bytes for valid legacy APP nanosecond fields above2^53; do not mistake their presence for unsafe protocol identity or rewrite them before the outer digest.
- [ ] **Step4 — GREEN:** C01–C08 positives/negatives, TERM→outerBLOCKED mapping, absent receipt/result before rejection, digest substitution, closed replay/new carrier correlation and deep/oversized/malformed payloads. Returned original bytes/snapshots stay unchanged.
- [ ] **Step5 — Commit:** `feat(install): read authenticated legacy and Core GitHub carriers`.

### Task12: Actual-reader registry, MCP pages and adoption evidence

**Files:** Create `readerQualification.ts`, `reader-qualification.test.ts`, `rbridgeReadResult.ts`, `rbridge-installation-client.ts`.

**Interfaces:** Consumes Task11 reader, ReaderRegistration and genuine private/source-bound fixtures. Produces `qualifyRBridgeReaders(registry:ReaderRegistry,fixtures:ReaderFixtureSet,runner:RegisteredReaderRunner):Promise<ReaderQualificationReport>`, `readRBridgeMcpOutput(client:McpReadClient,scope:Scope):Promise<McpReaderResult>`, fixed CLI `rbridgeReadResult`. Reports distinguish REFERENCE_PARSER_PASS from ACTUAL_READER_PASS and UNKNOWN adoption.

- [ ] **Step1 — RED:** `reference parser cannot close unnamed reader gate`, `MCP whole output SHA fails despite valid individual pages`, `actual version or adoption hash drift invalidates qualification`.

```ts
expect((await qualifyRBridgeReaders(unadoptedRegistry(), fixtures, runner)).actualAcceptance).toBe('UNKNOWN');
expect((await readRBridgeMcpOutput(validPagesWrongWholeDigest(), scope)).status).toBe('INVALID');
expect(report.acceptedCases).toEqual(['C01','C02','C03','C04','C05','C06','C07','C08','C09']);
```

- [ ] **Step2 — Confirm RED:** Reader qualification targeted suite; real official-SDK fixture retains package version and negotiated protocol separately.
- [ ] **Step3 — Implement:** Register owner/entrypoint/hash/version/context plus explicit actual-workflow adoption evidence. Invoke that exact reader for each applicable C01–C09 fixture; save reader-produced verdicts/inputs. Use genuine archived legacy HEALTH/FILE when available and exact producer-generated Core fixtures; sanitized/synthetic data is labeled as such, never authentic archive proof. MCP verifies binding, byte cursors, consistent receipt and concatenated whole-output SHA/fatal UTF8/canonical JSON, distinguishes NOT_READY/NOT_FOUND/terminal states, and does not resubmit. CLI supports fixed parse/qualification operations only. Locate/adopt each actual client through approved workflow; if unidentified or external reader remains unqualified, source task can finish with UNKNOWN but `prepare/apply` remains blocked.
- [ ] **Step4 — GREEN:** Exact reader matrix, wrong version/adoption, corrupted whole output, legacy modes and post-TTL original replay fixtures. Source SDK package2.3.0 negotiation tests are not evidence of two installed client versions.
- [ ] **Step5 — Commit:** `feat(install): qualify actual reader adoption and MCP output`.

### Task13: Configuration/pointer CAS preserving effective settings

**Files:** Create `configuration.py`, `test_configuration.py`.

**Interfaces:** Consumes Profile/Ledger/PauseLease/PublishedArtifact. Produces `install_configuration(profile:Profile,lease:PauseLease,ledger:Ledger,backend:HostBackend)->OwnedConfigChange`, `switch_pointer(profile:Profile,artifact:PublishedArtifact,lease:PauseLease,ledger:Ledger)->OwnedPointerChange`, `restore_owned_pre_start(changes:OwnedChanges,observed:ObservedTransactionState,lease:PauseLease,ledger:Ledger)->RestoreProof`.

- [ ] **Step1 — RED:** `later EnvironmentFile overrides earlier Environment`, `CPUQuota and concurrent dropin are never lost`, `CAS drift prevents restoration`.

```python
with self.assertRaises(ConfigError): install_with_preexisting_unowned_path()
self.assertEqual(after.cpu_quota, before.cpu_quota)
self.assertEqual(after.release_sha, RUNTIME_SHA)
self.assertFalse(restore_with_pointer_drift().may_start_old)
```

- [ ] **Step2 — Confirm RED:** Python configuration suite, including partial reload and crash after rename.
- [ ] **Step3 — Implement:** Prepare root0600 binding env/root0644 owned drop-in exact bytes, append EnvironmentFile after both preserved originals; refuse unowned paths. Validate effective order, both SHA variables, principal/target, old original hashes and all hardening/CPUQuota/drop-ins after fixed daemon reload. Record intent before config/pointer mutation, then observed completion. Replace only expected symlink atomically with fsync; restore only exact owned additions under CAS before START_ATTEMPTED and renewed paused compatibility proof. Never replace entire unit/environment or widen writable roots.
- [ ] **Step4 — GREEN:** Secret values absent from output, precedence, mode, unowned path, stale config/invocation and pointer drift negatives; unchanged unrelated bytes proven.
- [ ] **Step5 — Commit:** `feat(install): switch only owned configuration and release pointer`.

### Task14: Phase orchestration, crash resume and post-start hold

**Files:** Create `transaction.py`, `rbridge_install.py`, `test_transaction.py`.

**Interfaces:** Consumes qualified artifacts/readers, ledger, pause/backup, gate CLI, config functions and HostBackend. Produces `prepare_installation(profile:Profile,inputs:QualificationInputs)->PreparedInstallation`, `apply_installation(prepared:PreparedInstallation,authorization:SwitchAuthorization,backend:HostBackend)->TransactionResult`, `resume_installation(profile:Profile,ledger:Ledger,backend:HostBackend)->TransactionResult`. `SwitchAuthorization` binds exact profile/runtime/toolkit/helper digests and owner-present switch permission; spec/binding approval is insufficient.

- [ ] **Step1 — RED:** `failed start after fsynced START_ATTEMPTED never restarts008`, `SIGKILL between each phase recovers from observed state`, `stop timeout does not report stopped or release execution exclusion`.

```python
result = apply_fixture(start_returns_error=True)
self.assertEqual(result.phase, 'ROLLBACK_BLOCKED_START_ATTEMPTED')
self.assertFalse(backend.old_start_called)
self.assertTrue(backend.start_intent_preceded_new_start)
```

- [ ] **Step2 — Confirm RED:** Python transaction suite with fixed fake backend plus real child-process crash barriers.
- [ ] **Step3 — Implement:** Fixed CLI `prepare`, `check`, `apply`, `resume`, `status`; profile/toolkit closure validated before host actions. Block apply without exact artifact/reader qualification and explicit switch authorization. Hold maintenance exclusion from capture through controlled handoff; maintain paused backup/gates; config/pointer CAS; fsync START_ATTEMPTED then start. Before start, failures restore only owned unchanged state after fresh gates. After start, stop/observe/snapshot and refuse008 even with no visible Core operation. Unsettled stop is HOLD_UNSETTLED, not proven stopped exit4; no generic EXIT trap releases live execution locks or starts any release. Foreground owner-present handoff retains exclusion until settlement/explicit compatible recovery; unexpected helper death leaves durable ledger blocked, and never claims its kernel flock survived death. Deadlines bound attempts and emit uncertainty, not false finalization.
- [ ] **Step4 — GREEN:** Every phase crash/error, failed fsync/reload, lost ACK, alternate writer, config drift, closed Core canary/BLOCK, new legacy APP_RUN and corrupt ledger; assert no backup restore over new state and no accidental old start. Pure/fake tests are labeled separately from live privileged fixture qualification.
- [ ] **Step5 — Commit:** `feat(install): orchestrate bounded maintenance and conservative resume`.

### Task15: Authenticated real-transport acceptance and preserved replay

**Files:** Create `acceptance.py`, `rbridgeInstallationAccept.ts`, `test_acceptance.py`; extend SDK/GitHub fixtures.

**Interfaces:** Consumes installed artifact/profile/new invocation, actual qualified readers and predeclared canary identities. Produces `accept_installation(context:AcceptanceContext,backend:AcceptanceBackend)->AcceptanceReport`; Node `acceptRBridgeInstallation(input:InstallAcceptanceInput):Promise<InstallAcceptanceReport>`. Context binds current executable/full manifest, trusted transports, runtime/toolkit hashes, canary bytes and deadlines. Backend is fixed read-only observation plus exactly authorized HEALTH/FILE READ submissions and controlled candidate restart, never another app job/mutation/process operation.

- [ ] **Step1 — RED:** `environment release SHA cannot substitute installed bytes`, `same ID survives candidate restart TTL and carrier closure`, `lost publication ACK never causes new execution`.

```python
self.assertFalse(accept_fixture(env_sha_only=True).accepted)
self.assertEqual(replay.inner_receipt_sha256, original.inner_receipt_sha256)
self.assertEqual(replay.output_sha256, original.output_sha256)
self.assertEqual(backend.core_execution_count, 2)  # one HEALTH and one FILE READ
```

- [ ] **Step2 — Confirm RED:** Acceptance Python suite and real non-root isolated b588 producer/SDK fixture; two operations belong only to this controlled fixture, not a claim about other ordinarily admitted work.
- [ ] **Step3 — Implement:** Verify actual artifact/path/invocation/UID/effective config independently of HEALTH env metadata. Use unique predeclared reservation-checked IDs for GitHub HEALTH and bounded exact nonsensitive FILE READ; canary prepared via validated no-follow owned path, no symlink overwrite in shared parent. Qualified reader validates trusted request/comment, receipt scope/policy/outcome and exact output bytes/publication. MCP launched from immutable runtime under same binding looks up the same IDs, capabilities/status/result; no new execution for convergence. Controlled candidate restart and known post-TTL/closed reconciliation preserve original inner evidence, allowing only authenticated expected carrier differences. Bind fresh poll and source metadata evidence. Failure/timeout hands Task14 a post-start hold request, never old rollback.
- [ ] **Step4 — GREEN:** Wrong author/scope/policy, stale installed byte vs envSHA, forged/rehashed comment, changed canary, missing output/page, partial publication, restart failure, lost ACK and new other work fixtures. Actual production acceptance remains NOT_PERFORMED until separate authorized window.
- [ ] **Step5 — Commit:** `feat(install): accept installed bytes through real readers and transports`.

### Task16: Qualified bootstrap, complete verification and reviewed handoff

**Files:** Create `qualification.py`, `rbridge_bootstrap.py`, `test_bootstrap.py`. Modify `docs/INSTALLATION.md` upgrade/staging sections and `docs/OPERATIONS.md` maintenance/rollback sections; keep approved spec and this plan immutable during execution.

**Interfaces:** Consumes all proofs and exact toolkit/helper closure. Produces `build_qualification(profile:Profile,proofs:QualificationProofs)->QualificationBundle`, `verify_bootstrap_artifact(payload:bytes,manifest:BootstrapManifest,authenticated_capture:ArtifactCapture)->VerifiedBootstrap`, and `render_owner_command(bundle:QualificationBundle)->OwnerCommand`. Rendering refuses incomplete source/artifact/reader/privileged-fixture/import-closure evidence or missing exact reviewed bytes; command production switch still needs its own explicit authorization.

- [ ] **Step1 — RED:** `wrong payload length/hash or author cannot execute`, `bootstrap preserves sudo/outer exit and parent shell`, `unqualified actual reader prevents command readiness`.

```python
with self.assertRaises(BootstrapError): verify_bootstrap_artifact(tampered, manifest, capture)
self.assertEqual(render_incomplete_bundle().status, 'BLOCKED')
self.assertEqual(wrapper_fixture(exit_code=4).outer_exit, 4)
self.assertTrue(wrapper_fixture(exit_code=4).parent_shell_alive)
```

- [ ] **Step2 — Confirm RED:** Python bootstrap suite; synthetic authenticated artifact schema/length/hash negatives, no real sudo/service action.
- [ ] **Step3 — Implement:** Standalone stdlib bootstrap verifies safe root parent, authenticated artifact identity/readback, exact payload/closure lengths and SHA, exclusive protected copy and rehash, fixed PATH/CWD/isolated Python env; no root runtime-owned imports. Bundle exact source/test/log/toolkit/runtime/profile/reader/privileged-fixture proofs. Scope generic docs explicitly: old dist-only copy misses dependencies and blanket post-start pointer rollback is unavailable for P2A. Describe stopped compatible recovery, genuine status/exit meanings and evidence-preserving resume; no runnable production command from a draft/incomplete bundle.
- [ ] **Step4 — GREEN and qualification:** Run targeted Python/TS suites, all Python tests, full npm test/typecheck/lint/server build/diff/public scrub/clean checks on exact installation branch. Use dedicated non-root Node22 CI; preserve any Native root/runtime failures honestly. Separately qualify exact Node22.23.2 final artifact, actual readers and bounded root-only copier/ledger/config/stop fixtures in isolated protected directories/fake unit, never production. Run one fresh whole-branch review; resolve material findings regression-first and record exact final commit/tree. Publish/read back exact artifact bytes only when ready. If actual readers or privileged environment remain UNKNOWN, bundle/command stays BLOCKED while source qualification can pass.
- [ ] **Step5 — Commit:** `feat(install): qualify protected bootstrap and document P2A handoff`; save the execution ledger, immutable proofs and current blockers in the continuation record. No merge/deploy/sudo switch is implied by plan completion.

## Spec coverage and readiness checkpoints

| Spec section | Owning tasks | Required evidence |
| --- | --- | --- |
| 1–3 scope, alternatives and binding | 1,2,14 | Exact profile/source separation; no admission fence or continuity implied |
| 4 artifact/protected root closure | 2,3,16 | Final production dependency/import manifests; Node22.23.2 non-root artifact; root fixture qualification |
| 5 persistent phases/exclusion/recovery | 4,5,14 | Intent/fsync/crash/CAS/no008-after-start tests and maintained pause |
| 6 complete backup/five gates | 5–10 | Full shared snapshot, unchanged inventory and authenticated body correlation |
| 7 configuration/pointer ownership | 13,14 | Preserved originals/drop-ins/CPUQuota, effective precedence and CAS |
| 8 actual readers and C01–C09 | 11,12 | Supported legacy/Core digests, carrier integrity, actual adoption/client-version evidence |
| 9 real acceptance/post-start hold | 14,15 | Actual installed bytes/transports, original replay, settled hold or honest unresolved state |
| 10 negative/crash/bootstrap proof | 3–16 | Meaningful fixture outputs and exact-byte protected bootstrap qualification |
| 11 review/readiness handoff | 16 | Separate source/artifact/reader/paused/live gates, exact ledger and owner command review |

Task source deliverables may be complete while actual-reader identification, exact host interpreter, privileged fixture environment or installed acceptance remains UNKNOWN. That blocks preparation/application, not an excuse to manufacture PASS or broaden runtime policy. Fresh offline backup/gates are necessarily repeated during an authorized maintained pause; prior live observations are preparation evidence only.

**After plan approval:** Native implements the tasks on its own branch and preserves the method already selected. **Before production start:** require reviewed toolkit/bootstrap bytes, actual reader/artifact qualification, exact private profile, maintained paused backup/five gates and separate owner switch authorization. No sudo action is required to approve this plan.
