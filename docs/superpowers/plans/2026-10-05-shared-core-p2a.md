# Shared durable core — P2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner selects the execution method before implementation.

**Goal:** Give authenticated GitHub SAFE requests and local MCP clients one durable operation identity, bounded read-only execution, immutable terminal receipts, status, paged results and durable cancellation intent.

**Architecture:** A single non-root owner inside the existing relay holds both the existing relay exclusion and an owner-lifetime kernel lock. It owns a separate execution-v2 journal; stdio clients use private Unix IPC. Existing legacy jobs retain their engine and identity. HEALTH and six read-only FILE actions are enabled; PROCESS, CHUNK and FILE mutations receive durable policy BLOCKED receipts.

**Tech Stack:** Node 22, strict TypeScript/NodeNext, existing Zod 4 and official MCP server/client SDK 2.3.0, Vitest, Linux descriptor APIs and fixed `/usr/bin/flock`. Keep package dependencies and the lockfile unchanged unless a separately reviewed need emerges.

**Spec:** [2026-10-04-shared-core-p2a-design.md](../specs/2026-10-04-shared-core-p2a-design.md), SHA256 `12263bb240da6f6c743ca84615c4df1b2e712c9130b6d2d4bc5cfc51da2e3596`, published in design commit `917b19ea614bdcdcd1af8b42fc5a22fea4eb97a2`. The owner approved that design in the continuation on 2026-10-05. Its original draft-status wording is retained to preserve the reviewed bytes; this plan records the later approval. Implementation-plan review and execution-method selection are pending.

**Baseline:** main `c69b30abfcc10085f688c4603733b73514045b62`, tree `ec8d851d828839df039a2f64c26d7ef7ef041edd`. This document plans changes; none of its proposed tests, lock experiments or handlers is claimed to exist or pass yet.

## Global Constraints

- Keep `rbridgeExecutionContract.ts`, P0 intent/scope digests and P0 phase rules unchanged. An operation ID is the durable key across transports, not a transport-specific namespace.
- Deploy no code during this plan. Implementation, canonical source qualification, installation and live acceptance are separate steps. No production release switch or privileged command is authorized by design approval.
- Preserve non-root identity, repository/author authentication, legacy replay/collision protection, path/secret policy and the supervisor PASS guard. No APP_RUN, shell, generic subprocess, module-path fallback or request-selected root enters the core.
- Hold both writer exclusions before journal initialization, recovery, socket creation or legacy claim creation. Never delete the owner-lock inode to make acquisition succeed. Do not give its descriptor to handlers or supervisors.
- Root-controlled system ancestors and runtime-owned private state ancestors have different expected owners. Refuse symlinks or group/other write permission at either boundary. One UID is one local trust domain; do not claim protection from hostile processes using that UID or kernel peer-credential authentication.
- Preserve corrupt records and abandoned staging bytes. No automatic migration, terminal history deletion, receipt rewriting or ID reuse. A write/fsync error cannot manufacture PASS.
- Use per-ID serialization for admission and short durable updates, never across a handler await or network publication. Otherwise cancellation cannot commit while work is running.
- Keep the original policy document with its receipt snapshot. Recovery may intersect it with a stricter current policy; it may never broaden or replace that snapshot.
- Initial acceptance TTL limits new GitHub admission. Known receipts, result/status/cancel and publication reconciliation remain accessible after TTL expiry.
- Local socket restrictions must be reported honestly. Do not skip or weaken real Linux lock/socket tests to obtain green results. Canonical non-root CI must run the complete acceptance suite on the exact candidate tree.

## Review Focus

| Input/failure class | Required behavior | Owning tests |
| --- | --- | --- |
| Wrong UID/binding, hostile transport metadata, moved journal, reused legacy ID | No claim, foreign receipt or second engine | Tasks 1, 2, 4, 6, 11–13 |
| Oversized/deep JSON, FIFO/symlink swap, growing file, hostile cursor/frame | Bound memory/I/O; no blocking special-file open or unverified output | Tasks 1–3, 6, 7, 11 |
| Concurrent same-ID retries/collisions and exhausted storage/queue | One winner; original receipt intact; known queries continue without new allocations | Tasks 2–4, 8, 10, 13 |
| Owner/helper death, phase/result crash, disk-full or corruption | Exclusion before execution; retained truth; only harmless read recovery | Tasks 2, 3, 5, 9, 12, 13 |
| Queued/running abort, lost RPC acknowledgement, issue mutation/publication crash | Durable intent without false stoppage; no submit retry or execution caused by delivery | Tasks 6, 8–13 |

## Implementation choices to review with this plan

The following close details left open by the approved design. They do not enable additional actions.

1. Production persistent filesystems are initially limited to ext4, XFS and Btrfs using `statfs().type` (`0xef53`, `0x58465342`, `0x9123683e`). Refuse other types, including tmpfs, overlay, NFS and CIFS. A trusted test constructor may inject a filesystem checker for disposable fixtures; no environment or RPC override exists. Real flock/socket experiments on a disposable fixture prove those mechanisms, not persistence of an installed production journal.
2. IPC has at most 64 live connections, a 5,000 ms incomplete-frame deadline and a 10,000 ms RPC deadline. Read handlers have a 10,000 ms cooperative deadline. Deadline expiry requests cancellation; TERMINATED is committed only after actual handler settlement and descriptor closure. A filesystem await that has not settled remains nonterminal and occupies its slot.
3. Directory enumeration uses descriptor-backed streaming with at most 10,000 scanned entries and depth 32 for SEARCH. LIST preserves sorted first-N output with bounded storage; it fails with a scan-limit reason rather than loading an arbitrarily large directory. These limits and the read deadline are hashed into the policy.
4. Terminal operation records are frozen, including their bounded observations. While nonterminal, retain the first context per transport and saturating counters; terminal replay/status/result are read-only. This avoids making known queries depend on capacity for a new audit write. GitHub delivery observations remain in the separate delivery record.
5. Core-backed GitHub publication retains the V2 outer result envelope and existing chunk/manifest carrier for large output. It publishes the checked receipt and complete canonical output, with bounded authenticated comment pagination and separate delivery progress. It does not call the legacy publisher's unbounded whole-comment resume read.

## File map and shared interfaces

Paths below are relative to the repository. `Create` means a new focused module; existing modules retain their unrelated responsibilities.

| Files | Change and responsibility |
| --- | --- |
| `src/domain/rbridgeCoreProtocol.ts`, `rbridgeCoreValidation.ts` | Create discriminated results, bounds, RPC types and shared validators extracted from P1 |
| `src/server/rbridgeExecutionPolicy.ts` | Create fixed policy document and action-specific authorization |
| `src/server/rbridgeStateFiles.ts`, `rbridgeExecutionJournal.ts`, `rbridgeExecutionResults.ts`, `rbridgeDeliveryJournal.ts` | Create validated descriptors, atomic commits/accounting, operation/result/delivery storage |
| `src/server/rbridgeOperationSerializer.ts`, `rbridgeLegacyReservations.ts` | Create one owner-wide admission serializer and read-only legacy reservation probes |
| `src/server/rbridgeOwnerLock.ts`, `rbridgeCoreIpc.ts` | Create owner-lifetime flock acquisition and bounded server/client IPC |
| `src/server/rbridgeReadonlyHandlers.ts`, `remoteBridgeFileOps.ts` | Create P0 handler facade; harden existing descriptor-based reads without exposing mutations |
| `src/server/rbridgeExecutionCore.ts` | Create admission, scheduling, status/result/cancel and read recovery |
| `src/adapters/rbridgeGitHubCore.ts`, `rbridgeGitHubDelivery.ts`, `githubIssueRemoteBridge.ts` | Create trusted SAFE admission and resumable delivery; add fixed bounded GitHub API primitives |
| `src/server/rbridgeMcpSafe.ts`, `rbridgeMcpMain.ts` | Adapt P1 to the port, connect IPC and expose the three lookup/cancel tools |
| `src/server/rbridgeOwnerRuntime.ts`, `remoteBridgeMain.ts`, `remoteBridgeWorker.ts` | Create owner lifecycle assembly; route fresh SAFE and preserve legacy routing |
| `src/server/remoteBridgeStore.ts`, `flowPilotBridgeStore.ts`, `flowPilotBridgeRuntime.ts` | Add optional trusted claim guard; preserve old record schemas and engine behavior |
| `tests/domain/rbridge-core-protocol.test.ts`, `tests/server/rbridge-*.test.ts`, `tests/adapters/rbridge-github-core.test.ts`, `tests/fixtures/rbridge-*.ts` | Create behavioral fixtures and acceptance tests named in each task |
| `tests/server/remote-bridge-file-ops.test.ts`, `remote-bridge-store.test.ts`, `remote-bridge-worker.test.ts`, `flowpilot-bridge-store.test.ts`, `remote-bridge-main.test.ts`, `rbridge-mcp-safe.test.ts`, `tests/adapters/github-issue-remote-bridge.test.ts` | Extend existing regressions; use the actual discovered filenames before editing |
| `docs/remote-bridge-v2-p2a.md`, `README.md`, `docs/DEVELOPMENT_HISTORY.md` | Document implemented limits and qualification once actual implementation tests pass |

### Protocol names consumed by every later task (Task 1)

Use the approved `RBridgeCoreRejection`, `RBridgeCoreSubmitResult` and four-method `RBridgeCorePort` signatures exactly as written in the spec. Additional types:

```ts
interface RBridgeScope {
  operationId: string; principalId: string; targetInstanceId: string;
}
type RBridgeCoreLookupResult =
  | {status:'RECEIPT'; receipt:RBridgeExecutionReceiptV1}
  | ({status:'NOT_FOUND'} & RBridgeScope);
type RBridgeCoreResultPage =
  | {status:'RESULT'; receipt:RBridgeExecutionReceiptV1; resultSha256:string;
     cursor:number; nextCursor:number; eof:boolean; dataBase64:string}
  | {status:'NOT_READY'; receipt:RBridgeExecutionReceiptV1}
  | ({status:'NOT_FOUND'} & RBridgeScope);
type RBridgeCoreCancellationResult =
  | {status:'REQUESTED'|'UNCHANGED_TERMINAL'; receipt:RBridgeExecutionReceiptV1}
  | ({status:'NOT_FOUND'} & RBridgeScope)
  | ({status:'REJECTED'; reason:'RBRIDGE_CORE_SCOPE_INVALID'|
       'RBRIDGE_CORE_INTENT_COLLISION'} & RBridgeScope);
type RBridgeEnabledAction = 'HEALTH/STATUS'|'FILE/LIST'|'FILE/STAT'|
  'FILE/READ'|'FILE/READ_MANY'|'FILE/READ_BINARY'|'FILE/SEARCH';
interface RBridgeCoreBinding {
  schema:'RBRIDGE_CORE_BINDING_V1'; journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1';
  runtimeUid:number; principalId:string; targetInstanceId:string;
  policySha256:string; enabledActions:readonly RBridgeEnabledAction[];
}
type RBridgeDeploymentBinding = Pick<RBridgeCoreBinding,
  'runtimeUid'|'principalId'|'targetInstanceId'>;
type RBridgeCoreRpcRequest =
  | {schema:'RBRIDGE_CORE_RPC_V1'; action:'BINDING'}
  | {schema:'RBRIDGE_CORE_RPC_V1'; action:'SUBMIT'; submission:RBridgeOperationSubmissionV1}
  | {schema:'RBRIDGE_CORE_RPC_V1'; action:'STATUS'; operationId:string}
  | {schema:'RBRIDGE_CORE_RPC_V1'; action:'RESULT'; operationId:string;
     cursor:number; maxBytes:number}
  | {schema:'RBRIDGE_CORE_RPC_V1'; action:'CANCEL_INTENT'; operationId:string;
     intentSha256:string};
type RBridgeCoreRpcResponse =
  | {schema:'RBRIDGE_CORE_RPC_RESULT_V1'; action:RBridgeCoreRpcRequest['action'];
     value:RBridgeCoreBinding|RBridgeCoreSubmitResult|RBridgeCoreLookupResult|
       RBridgeCoreResultPage|RBridgeCoreCancellationResult}
  | {schema:'RBRIDGE_CORE_RPC_ERROR_V1'; reason:'RBRIDGE_CORE_RPC_INVALID'|
       'RBRIDGE_CORE_RPC_LIMIT'|'RBRIDGE_CORE_RPC_UNAVAILABLE'};
```

Runtime validation matches `action` to its exact value union, rejects unknown fields and checks receipt scope/intent; a wide TypeScript union is not sufficient validation. IPC carries no caller-supplied context. The owner builds MCP context with `authenticatedSubject: 'uid:<runtimeUid>'`; the GitHub adapter alone builds authenticated GITHUB context. In-process context validation also checks the configured subject, transport, principal and bounded requestRef.

Export `RBRIDGE_CORE_LIMITS`: submissionBytes=65536, depth=16, nodes=4096, requestBytes=65536, responseBytes=131072, nonterminal=128, handlers=4, connections=64, identities=10000, deliveries=10000, recordBytes=131072, journalBytes=67108864, resultBytes=536870912, outputBytes=8388608, pageBytes=32768, readBytes=1048576, paths=32, listEntries=500, searchMatches=500, scanEntries=10000, searchDepth=32, frameMs=5000, rpcMs=10000, handlerMs=10000. UTF-8 frame budgets include the final newline and envelope. An otherwise valid submission that cannot fit its RPC envelope is rejected locally before delegation; do not enlarge the frame limit silently.

Shared validator exports: `assertBoundedRBridgeJson(value:unknown, limits?:{bytes:number;depth:number;nodes:number}):void`, `canonicalRBridgeJson(value:RBridgeJsonValue):string`, `parseRBridgeCoreSubmitResult(value:unknown, submission:RBridgeOperationSubmissionV1):RBridgeCoreSubmitResult`, `parseRBridgeCoreLookupResult(value:unknown, scope:RBridgeScope):RBridgeCoreLookupResult`, `parseRBridgeCoreResultPage(value:unknown, scope:RBridgeScope, cursor:number, maxBytes:number):RBridgeCoreResultPage`, `parseRBridgeCoreCancellationResult(value:unknown, scope:RBridgeScope, intentSha256:string):RBridgeCoreCancellationResult`, `parseRBridgeCoreBinding(value:unknown):RBridgeCoreBinding`, and `parseRBridgeCoreRpcRequest(value:unknown):RBridgeCoreRpcRequest`. Default JSON limits are submission limits. Trusted result/journal validators use respectively 8388608/131072 bytes and 4096/8192 nodes, depth 16; never apply the 65536-byte input cap to a valid 1 MiB output. Receipt parsing is shared with P1; do not require P2-specific policy/postconditions in generic P0 receipt validation.

### Storage, policy and execution interfaces

Task 1 exports `RBridgePolicyDocumentV1`: schema `RBRIDGE_POLICY_DOCUMENT_V1`, version `safe-core-p2a-v1`, binding `RBridgeDeploymentBinding`, enabledActions, allowedRoots, limits and recovery `{incompleteReadonly:'REOBSERVE',mutation:'NEVER_RETRY'}`. All fields are immutable canonical JSON and hashed. `RBridgePolicyDecision` is `{document:RBridgePolicyDocumentV1;snapshot:RBridgePolicySnapshotV1}`. `RBridgeExecutionPolicy` has readonly document and `evaluate(submission:RBridgeOperationSubmissionV1):RBridgePolicyDecision`; `createRBridgeExecutionPolicy(binding:RBridgeDeploymentBinding):RBridgeExecutionPolicy` produces it. `isRBridgePolicyRecoveryAllowed(original:RBridgePolicyDocumentV1,current:RBridgePolicyDocumentV1,submission:RBridgeOperationSubmissionV1):boolean` checks authorization under both documents, using smaller limits. Owner handshake derives its policy hash from the document; that hash is not an input to itself.

Task 2 exports `RBridgeOperationRecordV1`: schema `RBRIDGE_OPERATION_RECORD_V1`, revision positive safe integer, normalized submission, intentSha256, policyDocument, receipt and observations. Observations are a map with only GITHUB/MCP/LOCAL keys, each `{first:RBridgeTransportContextV1;count:number}`; strings are bounded (subject 512 bytes, requestRef 512 bytes), counters saturate at MAX_SAFE_INTEGER, at most three rows. Terminal records are immutable. Keep record identity, receipt binding/digest and policy-document hash consistent on every read.

`createRBridgeExecutionJournal({root,binding,serializer})` is asynchronous. Its port `RBridgeExecutionJournal` is `get(id:string):Promise<RBridgeOperationRecordV1|undefined>`, `has(id:string):Promise<boolean>`, `claim(input:{submission:RBridgeOperationSubmissionV1;decision:RBridgePolicyDecision;context:RBridgeTransportContextV1}):Promise<RBridgeOperationRecordV1>`, `update(id:string,expectedRevision:number,next:RBridgeOperationRecordV1):Promise<RBridgeOperationRecordV1>`, `recover():Promise<readonly RBridgeOperationRecordV1[]>`, `capacity():RBridgeCapacity`, plus the accounting port below. Call claim/update only inside the supplied serializer. `RBridgeCapacity` contains identities, deliveries, nonterminal, journalBytes and resultBytes as nonnegative safe integers and `canClaim():boolean`. Recovery returns only validated incomplete records, at most 128; terminal records are checked/accounted in a bounded streaming scan. A total entry limit of 40000, including staging files, bounds startup even for empty orphan files; put that limit in the policy. Store no unbounded in-memory history.

Journal accounting consumed by Task 3: `reserveDelivery(issueNumber:number):Promise<void>`, `accountDeliveryCommit(issueNumber:number,bytes:number):Promise<void>`, `assertResultStageFits(operationId:string,bytes:number):void`, and `accountResultCommit(operationId:string,bytes:number):Promise<void>`. The same journal synchronizes budget reservations globally (in addition to per-ID serialization) so different IDs cannot overbook aggregate quotas. Release a failed reservation only after rescanning/accounting every file created by that attempt; never subtract uncertain bytes optimistically.

Task 3 exports `createRBridgeExecutionResults({root,journal})` with `commit(id:string,value:RBridgeJsonValue):Promise<{sha256:string;bytes:number}>` and `page(record:RBridgeOperationRecordV1,cursor:number,maxBytes:number):Promise<RBridgeCoreResultPage>`. `RBridgeDeliveryJournal` has `get(issueNumber:number):Promise<RBridgeGitHubDeliveryRecordV1|undefined>`, `claim(identity:RBridgeGitHubDeliveryIdentity):Promise<RBridgeGitHubDeliveryRecordV1>`, `update(issueNumber:number,expectedRevision:number,next:RBridgeGitHubDeliveryRecordV1):Promise<RBridgeGitHubDeliveryRecordV1>`, and `pending(limit:number):Promise<readonly RBridgeGitHubDeliveryRecordV1[]>`. `createRBridgeDeliveryJournal({root,journal})` produces it. Delivery types live in that module; their exact fields are specified in Task 10 for use here, so Task 3 has no source dependency on the later adapter.

Task 4 exports `RBridgeOperationSerializer` with `run<T>(id:string,task:()=>Promise<T>):Promise<T>` and `RBridgeLegacyClaimGuard` with `run<T>(id:string,task:()=>Promise<T>):Promise<T>`. Legacy guard holds the common serializer, checks core reservation, then invokes the original claim. Do not nest the common serializer inside itself. `createRBridgeLegacyReservations({requestRoot,flowPilotRoot,uid}).isReserved(id):Promise<boolean>` performs descriptor-only checks of canonical JSON and `.done` filenames; it does not heal, chmod, prune or adopt legacy records.

Task 7 exports `RBridgeReadonlyHandler` with `execute(submission:RBridgeOperationSubmissionV1,originalPolicy:RBridgePolicyDocumentV1,currentPolicy:RBridgePolicyDocumentV1,signal:AbortSignal):Promise<RBridgeJsonValue>`. Only verified HEALTH and enabled FILE actions reach it. `createRBridgeReadonlyHandlers({health,policy})` produces it; health is `{snapshot():unknown|Promise<unknown>}` and policy is `RBridgeExecutionPolicy`. It constructs FILE ops from the source policy internally.

Task 8 exports `createRBridgeExecutionCore({binding,subjects,journal,results,policy,legacyReservations,serializer,handler,now})` returning `RBridgeCorePort & {recover():Promise<void>;close():Promise<void>}`. Options consume `binding:RBridgeDeploymentBinding`, `subjects:{GITHUB:string;MCP:string;LOCAL?:string}`, named storage/handler ports, `policy:RBridgeExecutionPolicy` and `now?:()=>Date`. The owner configures GITHUB subject from authenticated repository/author and MCP subject `uid:<runtimeUid>`; LOCAL is disabled in production. `now` defaults to `()=>new Date()`. Trusted handler/I/O fixtures never come from requests.

## Increment 1 — protocol, policy and durable storage

Assertion blocks below belong inside the named Vitest tests. Each task's beforeEach creates its private fixtures with that task's named constructors and trusted dependencies; names such as `journal`, `core`, `submission` and `context` refer to those fixtures, not undefined product helpers. Use actual temporary files/processes for OS behavior and controlled ports only for deterministic scheduling/faults.

### Task 1: Shared protocol validation and fixed read-only policy

**Files:** Create `src/domain/rbridgeCoreProtocol.ts`, `src/domain/rbridgeCoreValidation.ts`, `src/server/rbridgeExecutionPolicy.ts`, `tests/domain/rbridge-core-protocol.test.ts`, `tests/server/rbridge-execution-policy.test.ts`. Modify `src/server/rbridgeMcpSafe.ts` to reuse extracted validators; extract the pure lexical/secret-path predicate from `src/server/remoteBridgeFileOps.ts`.

**Interfaces:** Produce protocol/validator/policy exports from the interface section. Consume unchanged P0 parser/digests/phase rules. P1 keeps its current injected-core interface until Task 11.

- [ ] Write `rejects caller provenance and unsafe nested JSON`, `validates scoped discriminated responses` and `authorizes exactly seven source-controlled actions`. Assert wrong scope/digest, extra fields, wrong RPC action/value pairing, nonfinite values, unsafe keys/depth/nodes/bytes, malformed base64 and hostile cursors fail. Keep all P1 receipt negatives and its different-policy/empty-postcondition fixture. Policy denies unsupported SAFE actions and unknown named arguments without changing normalized intent.

```ts
// rejects caller provenance and unsafe nested JSON
expect(() => parseRBridgeCoreRpcRequest({schema:'RBRIDGE_CORE_RPC_V1',
  action:'BINDING', transport:'GITHUB'})).toThrow();
expect(() => assertBoundedRBridgeJson(JSON.parse('{"x":{"constructor":1}}'))).toThrow();
// authorizes exactly seven source-controlled actions
expect(policy.document.allowedRoots).toEqual(['/mnt/data']);
expect(policy.document.enabledActions).toHaveLength(7);
expect(RBRIDGE_CORE_LIMITS.outputBytes).toBe(8388608);
```

- [ ] Run `npm test -- tests/domain/rbridge-core-protocol.test.ts tests/server/rbridge-execution-policy.test.ts tests/server/rbridge-mcp-safe.test.ts`; expect missing new exports, with existing P1 behavior preserved.
- [ ] Implement iterative bounded traversal before canonicalization, exact discriminated response validation and extracted strict P0/P1 receipt checks. Fixed policy accepts no args for HEALTH/STAT/READ/READ_BINARY; LIST only optional maxEntries 1..500; READ_MANY only paths (1..32 relative strings <=1024 bytes each, no empty/dot/parent/NUL components); SEARCH only query (1..4096 UTF-8 bytes, no NUL). Reuse source root/secret rules and hash the full immutable policy. Disabled actions retain their intent and receive policy BLOCK.
- [ ] Run the targeted command, `npm run typecheck` and `git diff --check`; require all targeted/P1 tests PASS.
- [ ] Stage only this task's Files and commit `feat(core): define bounded P2A protocol and read-only policy`.

### Task 2: Manifest-bound journal, CAS and quota reservations

**Files:** Create `src/server/rbridgeStateFiles.ts`, `src/server/rbridgeExecutionJournal.ts`, `src/server/rbridgeOperationSerializer.ts`, `tests/server/rbridge-execution-journal.test.ts`, `tests/server/rbridge-state-files.test.ts`.

**Interfaces:** Produce the journal/serializer/accounting ports. State exports: `readRBridgeStateFile(path:string,uid:number,maxBytes:number):Promise<Buffer>`, `commitRBridgeStateFile(path:string,data:Buffer,uid:number,createOnly:boolean):Promise<void>`, `validateRBridgeStateTree(root:string,uid:number):Promise<void>`. Private typed I/O dependencies permit deterministic fsync/rename failure; production uses Node filesystem functions.

- [ ] Write `rejects moved or unsafe state without repairing it`, `does not acknowledge an unconfirmed durable commit` and `reserves aggregate capacity atomically`. Cover manifest UID/principal/target, filename/content identity, symlink/hardlink/FIFO/foreign owner/mode, corrupt/oversized JSON, revision/phase, concurrent IDs and create/fsync/rename/parent-fsync faults. At default result budget 32 maximum reservations fit; number 33 fails despite queue limit 128. Exercise identity/queue limits separately with trusted accounting fixtures.

```ts
// reserves aggregate capacity atomically; fixture already has 32 reservations
expect(journal.capacity().nonterminal).toBe(32);
expect(journal.capacity().canClaim()).toBe(false);
expect(await journal.get('known.read')).toBeDefined();
// rejects moved or unsafe state without repairing it
expect(await readFile(corruptPath)).toEqual(originalCorruptBytes);
```

- [ ] Run `npm test -- tests/server/rbridge-state-files.test.ts tests/server/rbridge-execution-journal.test.ts`; expect missing new modules.
- [ ] Implement nonblocking no-follow descriptor reads, regular one-link UID/mode validation and bounded cap+1 reads. Validate root-owned system ancestors separately from private runtime ancestors. Commit with exclusive staging, file fsync, atomic placement and parent fsync; createOnly never overwrites a winner. Recheck revision and identity on update. Serialize aggregate reservations globally and each ID locally. Persist original policy/receipt and bounded first-context counters, freeze terminal records. Stream startup accounting, count staging/unknown retained bytes and enforce 40000 total entries. Reserve twice maximum record/result sizes before claim; release unused space only after durable actual bytes are accounted.
- [ ] Run the targeted tests, typecheck and diff check; require no acknowledged success on injected fsync failure and no automatic repair/deletion.
- [ ] Commit `feat(core): add identity-bound durable journal and quota accounting`.

### Task 3: Verified result files and separate delivery storage

**Files:** Create `src/server/rbridgeExecutionResults.ts`, `src/server/rbridgeDeliveryJournal.ts`, `tests/server/rbridge-execution-results.test.ts`, `tests/server/rbridge-delivery-journal.test.ts`. Modify journal accounting.

**Interfaces:** Produce the result/delivery ports specified above; delivery schema is defined in Task 10 but lives in the storage module. Consume state commits and journal accounting.

- [ ] Write `verifies the whole result before serving any page`, `bounds canonical output and byte cursors` and `delivery exhaustion leaves execution intact`. Cover 8 MiB including escaping/base64, multibyte boundaries, EOF, cursors/maxBytes, output corruption/missing digest, commit faults and retained stages. Pending delivery scans must include locally pending records whose remote issues have closed.

```ts
// verifies the whole result before serving any page
expect(page.resultSha256).toBe(receipt.resultSha256);
expect(page.nextCursor - page.cursor).toBeLessThanOrEqual(32768);
expect(page.dataBase64).toBe(Buffer.from(expectedSegment).toString('base64'));
// bounds canonical output and byte cursors
await expect(results.page(record, -1, 32768)).rejects.toThrow();
await expect(results.page(record, 0, 32769)).rejects.toThrow();
```

- [ ] Run `npm test -- tests/server/rbridge-execution-results.test.ts tests/server/rbridge-delivery-journal.test.ts`; expect missing exports.
- [ ] Implement bounded canonical output and fsynced atomic result placement before terminal receipt. Hash with 64 KiB streaming buffers before serving a <=32768-byte page. Terminal output cannot be replaced; incomplete read output may be reobserved under its reservation. Delivery files use positive issue-number keys, 0600, <=131072 bytes, <=10000 records and common journal/delivery budget. Capacity refusal never allocates a V1 claim or changes an execution receipt.
- [ ] Run these tests plus journal tests, typecheck and diff check; require output verification and accounting assertions PASS.
- [ ] Commit `feat(core): persist verified results and separate GitHub deliveries`.

## Increment 2 — writer exclusion and bounded local IPC

### Task 4: Reserve legacy IDs in both directions

**Files:** Create `src/server/rbridgeLegacyReservations.ts`, `tests/server/rbridge-legacy-reservations.test.ts`. Modify `src/server/remoteBridgeStore.ts`, `src/server/flowPilotBridgeStore.ts`, `src/server/flowPilotBridgeRuntime.ts` and their existing tests.

**Interfaces:** Produce reservation probe/common guard. Extend V1 as `createRemoteBridgeStore(root:string,now:()=>Date=()=>new Date(),options:{claimGuard?:RBridgeLegacyClaimGuard}={})`. Add optional claimGuard to `FlowPilotBridgeStoreOptions` and `FlowPilotBridgeRuntimeOptions`; runtime passes it as the existing store's third argument, preserving the optional clock. Production wiring always supplies it.

- [ ] Write `probes legacy reservations without store side effects` and `core and legacy claims cannot both win`. Cover V1 JSON, FlowPilot JSON/.done, FlowPilot's 192-character IDs, missing and malformed/special candidates, and races against both stores. Existing replay retains its original engine/record; no probe calls get/pending/prune/heal/chmod.

```ts
// probes legacy reservations without store side effects
expect(await reservations.isReserved(legacyId)).toBe(true);
expect(await reservations.isReserved(tombstonedId)).toBe(true);
expect(await readFile(legacyPath)).toEqual(originalLegacyBytes);
// core and legacy claims cannot both win
expect(coreClaims + legacyClaims).toBe(1);
expect(losingEngineCalls).toBe(0);
```

- [ ] Run `npm test -- tests/server/rbridge-legacy-reservations.test.ts tests/server/remote-bridge-store.test.ts tests/server/flowpilot-bridge-store.test.ts`; expect new guard assertions to fail.
- [ ] Implement descriptor-only per-ID probes, not an unbounded history cache. Wrap complete legacy lookup/create in the common guard, then its internal serializer. Core takes the same common serializer and checks both legacy locations before claim. Guard rejects a core-reserved legacy ID with `RBRIDGE_CORE_LEGACY_ID_RESERVED` before creation. Thread it through FlowPilot runtime without changing schemas, retention, callbacks, controller behavior or supervisor PASS guard.
- [ ] Run targeted tests plus existing FlowPilot gateway/runtime tests, typecheck and diff check; require original replay behavior preserved.
- [ ] Commit `feat(core): prevent operation ID reuse across legacy stores`.

### Task 5: Retain the kernel lock in the owner

**Files:** Create `src/server/rbridgeOwnerLock.ts`, `tests/server/rbridge-owner-lock.test.ts`, `tests/fixtures/rbridge-owner-lock-child.ts`; modify filesystem validation.

**Interfaces:** `acquireRBridgeOwnerLock({root,uid}):Promise<{close():Promise<void>}>` maps the owner's validated descriptor to helper fd9 and invokes fixed `/usr/bin/flock` with `['-n','9']`. Trusted test construction may control scheduling; no runtime helper-path override exists.

- [ ] Write real-process `helper exit does not release a live owner lock`, `owner death releases despite a surviving child` and `unconfirmed acquisition never starts IPC`. Cover two owners, unchanged inode, helper failure/kill, owner SIGKILL, symlink/foreign lock, and supported/unsupported filesystem. A fixture shim may run actual fd-form flock and pause acknowledgement to exercise a helper-boundary kill; also test the normal production helper path.

```ts
// helper exit does not release a live owner lock
expect(secondOwnerAcquired).toBe(false);
// owner death releases despite a surviving child
expect(supervisorChildStillAlive).toBe(true);
expect(replacementOwnerAcquired).toBe(true);
expect(afterLockInode).toBe(beforeLockInode);
```

- [ ] Run `npm test -- tests/server/rbridge-owner-lock.test.ts`; expect new modules missing. Real OS cases remain mandatory; record local restrictions and run unchanged cases on canonical non-root CI.
- [ ] Implement no-follow one-link regular UID/mode lock open, fixed helper invocation, cleanup on unconfirmed acquisition and owner-held FileHandle until shutdown. Every other child has explicit/default stdio excluding this FD. Validate conservative production statfs support; fixture filesystem-check injection never comes from env/RPC. Do not delete the lock inode.
- [ ] Run real targeted processes, typecheck and diff check; record tested source tree/filesystem rather than inferring correctness from spawn mocks or strings.
- [ ] Commit `feat(core): enforce owner-lifetime Linux writer lock`.

### Task 6: Bounded one-RPC IPC and checked handshake

**Files:** Create `src/server/rbridgeCoreIpc.ts`, `tests/server/rbridge-core-ipc.test.ts`, `tests/fixtures/rbridge-ipc-owner.ts`.

**Interfaces:** `startRBridgeCoreIpcServer({root,binding,core}):Promise<{close():Promise<void>}>` requires held exclusions. `connectRBridgeCoreIpcClient({root,expectedBinding}):Promise<RBridgeCorePort & {binding():Promise<RBridgeCoreBinding>;close():Promise<void>}>`. Root derives from runtime homedir; client context must match configured MCP binding and is never sent as authority.

- [ ] Write `rejects wrong owner or handshake before submit`, `bounds fragmented frames and connection floods` and `lost submit acknowledgement never retries`. Cover socket/ancestor UID/type/permissions/symlinks, owner unavailable, action/schema/policy binding, split frames, invalid UTF-8, second/trailing frame, exact byte edges, 65th connection and deadlines. Abort before send creates no claim; after send attempts one separate CANCEL_INTENT with original ID/digest, including lost cancel acknowledgement/collision cases.

```ts
// bounds fragmented frames and connection floods
expect(RBRIDGE_CORE_LIMITS.requestBytes).toBe(65536);
expect(RBRIDGE_CORE_LIMITS.responseBytes).toBe(131072);
expect(maxObservedConnections).toBeLessThanOrEqual(64);
// lost submit acknowledgement never retries
expect(submitRpcCount).toBe(1);
expect(cancelRpcCount).toBeLessThanOrEqual(1);
```

- [ ] Run `npm test -- tests/server/rbridge-core-ipc.test.ts`; expect missing modules; distinguish any local socket restriction.
- [ ] Implement fatal UTF-8 newline framing, one RPC/connection, count/byte/deadline limits and strict response/action matching. Frame budgets include envelope/newline; reject a too-large submission frame before delegation. Server derives MCP context, never GITHUB provenance. Create/remove/chmod the validated socket only while owner lock is held. Client uses separate RPC connections and prior BINDING; capabilities use a fresh handshake. Never retry SUBMIT. In-flight abort attempts one bounded CANCEL_INTENT without reusing the aborted signal; unknown delegated outcomes remain unknown.
- [ ] Run IPC/protocol tests, typecheck and diff check; require malformed frames never reach the test port and diagnostics contain only bounded fixed reasons.
- [ ] Commit `feat(core): expose bounded identity-checked local IPC`.

## Increment 3 — bounded reads, scheduling and truthful recovery

### Task 7: Descriptor-safe bounded reads and P0 facade

**Files:** Create `src/server/rbridgeReadonlyHandlers.ts`, `tests/server/rbridge-readonly-handlers.test.ts`, `tests/fixtures/rbridge-file-race.ts`; modify `src/server/remoteBridgeFileOps.ts` and its existing tests.

**Interfaces:** Produce `RBridgeReadonlyHandler`. Extend `fileOps.execute(operation,options?:{signal?:AbortSignal})` without changing valid legacy return shapes. Production fixes `/mnt/data`, 1 MiB combined reads and 500 SEARCH matches; fixture source roots are trusted construction only.

- [ ] Write real `rejects FIFO without blocking`, `rejects substituted directory components`, `bounds a growing file during reading` and `settles cancellation after closing handles`. Cover STAT/READ_MANY FIFO, parent/symlink swap, missing/binary file, combined bytes, directory scan and iteration/read cancellation. Potential hangs run in a child with a failing deadline and guaranteed cleanup. Facade negatives refuse all disabled handlers/unknown args and invalid HEALTH output.

```ts
// rejects FIFO without blocking
expect(fifoChildTimedOut).toBe(false);
expect(fifoChildResult.status).toBe('REJECTED');
// bounds a growing file during reading
expect(maxObservedReadAllocation).toBeLessThanOrEqual(1048577);
// settles cancellation after closing handles
expect(openHandlesAtSettlement).toBe(0);
expect(mutationHandlerCalls).toBe(0);
```

- [ ] Run `npm test -- tests/server/remote-bridge-file-ops.test.ts tests/server/rbridge-readonly-handlers.test.ts`; record actual new FIFO/growth/cancel failures against the current handler before fixing them.
- [ ] Implement read-only descriptor walking for every directory component using O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK; validate final fstat/descriptor path and reject special/secret files. Replace unbounded readFile calls with <=64 KiB chunks capped to remaining bytes+1, checking abort between operations. READ_MANY shares its byte cap while reading. Use descriptor-backed opendir with bounded sorted output, 10000 scans/depth32 and cancellation checks; close every FD in finally. Facade intersects original/current limits, validates canonical JSON/output bytes and HEALTH, and returns sanitized fixed failure codes. A cooperative 10-second deadline cannot claim settlement while filesystem I/O remains pending.
- [ ] Run targeted tests including all original FILE mutation cases, typecheck and diff check; require preserved valid return shapes and no new core mutation authorization.
- [ ] Commit `fix(file): bound descriptor reads and support settled cancellation`.

### Task 8: Durable admission and bounded read scheduler

**Files:** Create `src/server/rbridgeExecutionCore.ts`, `tests/server/rbridge-execution-core.test.ts`.

**Interfaces:** Produce core factory/port from the interface section; consume journal/results/policy/serializer/reservations/handler. Return deep immutable snapshots.

- [ ] Write `one intent wins an ID`, `rejection creates no claim`, `authorization returns before execution` and `PASS requires committed verified output`. Cover scope/subject, legacy, capacity, disabled action short BLOCK, four-handler/128-queue behavior and bounded observation floods. Queue-limit fixtures do not replace the actual default 32-reservation test.

```ts
// authorization returns before execution
expect(submitResult.status).toBe('RECEIPT');
expect(submitResult.receipt.phase).toBe('AUTHORIZED');
expect(submitResult.receipt.transitions.map(t => t.phase))
  .toEqual(['CLAIMED','AUTHORIZED']);
expect(maxConcurrentHandlers).toBeLessThanOrEqual(4);
// rejection creates no claim
expect(await journal.get(rejectedId)).toBeUndefined();
```

- [ ] Run `npm test -- tests/server/rbridge-execution-core.test.ts`; expect missing core exports.
- [ ] Implement serialized admission: bounded/frozen input, configured subject/scope, existing replay/collision, legacy probe, aggregate reservation, policy, durable claim/authorization. Pre-admission abort creates nothing. Known admission rejection returns the approved union, not a receipt. Dispatch outside long-held locks; commit STARTING/RUNNING before handler, verified result before PASS. Terminal PASS has `read-within-policy` and `result-digest` PASS postconditions/evidence; read error has sanitized FAIL/BLOCKED and NONE_PROVEN, durability error never PASS. Known status/result/replay allocate no new identity or queue slot. Never emit PROCESS_PROVEN_STOPPED or ROLLED_BACK.
- [ ] Run core/journal/result/policy/reservation tests, typecheck and diff check; require AUTHORIZED snapshots stay exact after eventual completion and original collision winner stays intact.
- [ ] Commit `feat(core): admit and schedule durable read-only operations`.

### Task 9: Interrupted-read recovery and durable cancellation

**Files:** Modify `src/server/rbridgeExecutionCore.ts`; create `tests/server/rbridge-execution-recovery.test.ts`, `tests/server/rbridge-execution-cancellation.test.ts`, `tests/fixtures/rbridge-crash-owner.ts`.

**Interfaces:** Complete recover/requestCancel/close; consume immutable original policy and result verification. No recovery creates a new operation identity.

- [ ] Write `terminal recovery never calls a handler`, `incomplete reads reobserve without broadening policy`, `queued cancel has the authorized terminal path` and `running cancel waits for actual settlement`. Crash at claim/each phase/result fsync/rename/terminal commit; include ENOSPC/corruption, changed source, policy tightening and completion/cancel races. Wrong digest/unknown ID cannot modify the winner.

```ts
// queued cancel has the authorized terminal path
expect(receipt.transitions.map(t => t.phase))
  .toEqual(['CLAIMED','AUTHORIZED','TERMINAL']);
expect(receipt.outcome).toBe('TERMINATED');
expect(receipt.policy.decision).toBe('ALLOW');
expect(receipt.cancellation.state).toBe('REQUESTED');
expect(receipt.sideEffects.state).toBe('NONE_PROVEN');
expect(handlerCalls).toBe(0);
```

- [ ] Run `npm test -- tests/server/rbridge-execution-recovery.test.ts tests/server/rbridge-execution-cancellation.test.ts`; expect unimplemented recovery/cancel assertions to fail.
- [ ] Implement monotonic recovery: original policy-BLOCK CLAIMED finishes its short BLOCKED path; original ALLOW CLAIMED first advances AUTHORIZED before any current-policy BLOCKED terminal. Retain original snapshot and add `current-policy-restriction` with current decision evidence. Only incomplete reads may reobserve, including persisted RUNNING; terminal bytes never change. Cancel commits REQUESTED under short serialization, then signals outside the lock. Queued cancel never dispatches; running TERMINATED requires settled handler/closed FDs. Verified completion may win; late cancel is exact UNCHANGED_TERMINAL. Shutdown rejects ingress and awaits handlers before releasing ownership; stuck I/O remains nonterminal/owned until process death.
- [ ] Run recovery/cancel/core and real crash tests, typecheck and diff check; require retained truth on disk/full/fsync/corruption and no invalid short TERMINATED path.
- [ ] Commit `feat(core): recover reads and persist cancellation intent`.

## Increment 4 — GitHub, stdio and owner lifecycle

### Task 10: Authenticated GitHub admission and independent resumable publication

**Files:** Create `src/adapters/rbridgeGitHubCore.ts`, `src/adapters/rbridgeGitHubDelivery.ts`, `tests/adapters/rbridge-github-core.test.ts`, `tests/adapters/rbridge-github-delivery.test.ts`; modify `src/adapters/githubIssueRemoteBridge.ts` and its existing tests.

**Interfaces:** `createRBridgeGitHubCore({repository,authorLogin,binding,core,deliveries,github,now})` returns `{admit(issue:GitHubBridgeIssue):Promise<'CORE'|'PUBLICATION_UNAVAILABLE'>;reconcileDeliveries(limit:number):Promise<void>}`. It receives SAFE candidates selected by Task 12 and never invokes the legacy engine. PUBLICATION_UNAVAILABLE leaves accepted execution intact, emits a sanitized pending/error summary and keeps the issue open without repeated unjournaled comments.

Fixed GitHub port: `readIssue(number:number):Promise<GitHubBridgeIssue & {state:'open'|'closed'}>`, `readCommentPage(number:number,page:number):Promise<readonly RBridgeGitHubComment[]>`, `postComment(number:number,body:string):Promise<RBridgeGitHubComment>`, `closeIssue(number:number):Promise<void>`. Comment has id (positive safe integer), authorLogin, body and url strings. Fixed per_page20/page1..52, <=2000000 bytes/command, <60000 bytes/comment, <=1024 scanned comments, timeout30000 ms and `/usr/bin/gh` with shell:false; no caller argv/repository/executable.

Storage schema from Task 3: `RBridgeGitHubDeliveryIdentity` is repository, issueNumber, authorLogin, exact title, bodySha256, requestSha256, operationId and intentSha256. `RBridgeGitHubDeliveryRecordV1` has schema `RBRIDGE_GITHUB_DELIVERY_V1`, revision, identity, state PENDING|PUBLISHED|IDENTITY_BLOCKED, optional publication `{envelopeSha256,totalBytes,chunkCount,nextIndex,manifestCommentId?,receiptCommentId?}`, lastReason (<=512 bytes) and saturating attempts. Publication is absent until terminal preparation. Reproduce its frozen envelope from immutable receipt/output, stored identity and terminal transition timestamp; no retry-time completedAt or receipt REPLAY rewrite.

Outer `COCWIN_REMOTE_BRIDGE_RESULT_V2` retains requestId, issueNumber, requestSha256, completedAt and status. operationResult is `{schema:'RBRIDGE_GITHUB_CORE_RESULT_V1';receipt;output?:RBridgeJsonValue}`. Map PASS/FAIL/BLOCKED/UNCERTAIN directly; TERMINATED maps to outer BLOCKED reason `RBRIDGE_CORE_TERMINATED`, retaining exact inner outcome. Outer resultSha256 hashes JSON.stringify(operationResult); receipt.resultSha256 separately hashes canonical output bytes.

- [ ] Write `authenticates before delegation and preserves known expired IDs`, `publication failure never reexecutes` and `closed issue reconciliation proves its existing receipt`. Cover unauthorized/changed identity/body, unsafe/deep JSON, fresh TTL expiry, known replay/collision/new issue, delivery capacity, crash after comment/manifest/close/before local PUBLISHED, hostile author/digest, >2 MiB paginated history, 8 MiB output and 1024-comment bound.

```ts
// publication failure never reexecutes
expect(handlerCallsAfterRetry).toBe(handlerCallsBeforeRetry);
expect(receiptAfterRetry).toEqual(originalTerminalReceipt);
// closed issue reconciliation proves its existing receipt
expect(remoteIssue.state).toBe('closed');
expect(delivery.state).toBe('PUBLISHED');
expect(reassembledOutputSha256).toBe(originalTerminalReceipt.resultSha256);
```

- [ ] Run `npm test -- tests/adapters/rbridge-github-core.test.ts tests/adapters/rbridge-github-delivery.test.ts tests/adapters/github-issue-remote-bridge.test.ts`; expect new adapter behavior missing.
- [ ] Implement bounded authenticated V2→P0 normalization with configured scope; only new IDs require unexpired initial TTL. Unsupported SAFE goes to durable core BLOCK, not legacy dispatch. Claim a separate capacity-checked delivery; no publication creates a V1 claim or reruns execution. For terminal output, verify/reassemble result pages and publish the frozen envelope using existing 40000-byte raw chunk/manifest schemas. Read authenticated bounded comment pages instead of the legacy whole-history resume call; compare exact bodies/digests, including uncertain remote writes. Each pass sends <=8 missing chunks, checks current issue identity and returns to the loop. Only verified comments/manifest and closed state allow local PUBLISHED. Changed identity durably blocks delivery without changing execution.
- [ ] Run new/old GitHub carrier tests and journal/core tests, typecheck and diff check; require full output digest verified independently of outer envelope digest.
- [ ] Commit `feat(core): share GitHub identity and durable result delivery`.

### Task 11: MCP IPC connection and scoped status/result/cancel

**Files:** Modify `src/server/rbridgeMcpSafe.ts`, `src/server/rbridgeMcpMain.ts`, `tests/server/rbridge-mcp-safe.test.ts`; create `tests/server/rbridge-mcp-core.test.ts`, `tests/fixtures/rbridge-stdio-owner.ts`.

**Interfaces:** RBridgeMcpCore becomes the shared RBridgeCorePort alias. Add trusted `bindingProvider?:()=>Promise<RBridgeCoreBinding>`; production supplies fresh IPC handshake. `runRBridgeMcpMain():Promise<StdioServerHandle>` resolves existing non-root binding, fixed homedir state root and checked IPC before serving stdio. New strict tools: status({operationId}), result({operationId,cursor,maxBytes}), cancel({operationId,intentSha256}). Query outer schema is `RBRIDGE_MCP_CORE_QUERY_RESULT_V1` with tool and checked result. Submit retains `RBRIDGE_MCP_SUBMISSION_RESULT_V1`/CORE_RECEIPT; known rejection maps to BLOCKED with exact reason/scope. Unusable/exceptional delegated outcomes are UNCERTAIN `RBRIDGE_MCP_CORE_RESULT_UNKNOWN`; invalid/disconnected pre-delegation is BLOCKED without receipt.

- [ ] Write `modern and legacy stdio clients share checked core results`, `known rejection is blocked without a fake receipt` and `owner loss clears connected capabilities`. Adapt existing P1 fixtures to tagged submit/four methods, retaining all receipt negatives. Test five-tool discovery, trusted enabled actions, bounded read/status/pages/SHA, disabled BLOCK, strict metadata/identity inputs, abort/lost acknowledgement and reconnect by original ID with no submit retry.

```ts
// known rejection is blocked without a fake receipt
expect(response.status).toBe('BLOCKED');
expect(response.reason).toBe('RBRIDGE_CORE_INTENT_COLLISION');
expect(Object.hasOwn(response, 'receipt')).toBe(false);
// owner loss clears connected capabilities
expect(capabilities.executionAvailable).toBe(false);
expect(submitRpcCount).toBe(1);
```

- [ ] Run `npm test -- tests/server/rbridge-mcp-safe.test.ts tests/server/rbridge-mcp-core.test.ts`; expect new tools/connection behavior to fail.
- [ ] Implement strict shared input/output mapping, trusted context and async IPC-only entrypoint. Fresh capabilities handshake supplies policy/actions; never preserve stale CORE_CONNECTED. No executor/module fallback; reusable factory retains unconfigured BLOCKED mode. Cleanup closes IPC, root/wrong-runtime startup stays rejected, stdout remains protocol-only and stderr fixed/sanitized. Port exceptions after delegation remain uncertain, with at most one separate cancellation attempt.
- [ ] Run real modern/legacy SDK, IPC/protocol, typecheck and diff checks; preserve root-startup negative and require positive entrypoint cases on non-root CI.
- [ ] Commit `feat(mcp): connect durable core and add scoped query tools`.

### Task 12: One owner lifecycle and preserved legacy routing

**Files:** Create `src/server/rbridgeOwnerRuntime.ts`, `tests/server/rbridge-owner-runtime.test.ts`; modify `src/server/remoteBridgeMain.ts`, `src/server/remoteBridgeWorker.ts` and their existing tests.

**Interfaces:** `startRBridgeOwnerRuntime({runtimeIdentity,env,github,health})` requires already-held relay exclusion, acquires owner lock and returns `Promise<{core:RBridgeCorePort;githubCore:ReturnType<typeof createRBridgeGitHubCore>;claimGuard:RBridgeLegacyClaimGuard;close():Promise<void>}>`. runtimeIdentity is `{username:string;homedir:string;uid:number;euid:number}`, env is `Record<string,string|undefined>`, github is Task 10's fixed port plus existing list/publish port, health is `{snapshot():unknown|Promise<unknown>}`. Worker options add optional trusted githubCore/reservations; production always supplies them, old unit factories remain supported.

- [ ] Write `locks precede every writer and socket`, `new SAFE never falls back to legacy` and `cleanup retains exclusion until work settles`. Cover wrong/missing binding, partial startup/IPC/recovery failure, cleanup order, stored V1/V2 IDs staying legacy, new SAFE durable BLOCK, V1/APP_RUN legacy, core-reserved legacy claim rejection, unscoped legacy failures, known core expiry and closed deliveries.

```ts
// locks precede every writer and socket
expect(events.indexOf('owner-lock-held')).toBeLessThan(events.indexOf('ipc-listening'));
// cleanup retains exclusion until work settles
expect(events.indexOf('handlers-settled')).toBeLessThan(events.indexOf('owner-lock-released'));
expect(events.indexOf('flowpilot-stopped')).toBeLessThan(events.indexOf('relay-lock-released'));
// new SAFE never falls back to legacy
expect(newSafeLegacyHandlerCalls).toBe(0);
```

- [ ] Run `npm test -- tests/server/rbridge-owner-runtime.test.ts tests/server/remote-bridge-main.test.ts tests/server/remote-bridge-worker.test.ts`; expect missing assembly/routing assertions.
- [ ] Reorder main so configuration/identity and relay acquisition precede owner lock, journal/recovery, guarded legacy store/FlowPilot initialization and ingress. Authenticate/bound structurally before selecting an existing legacy reservation; new SAFE goes core without fallback, V1/APP_RUN stay legacy. Handle guard rejection as known BLOCKED without controller calls. Drain deliveries in bounded batches of 20 independently of open issues. Make loop lock.release a composite cleanup: stop ingress/IPC, settle core and stop FlowPilot, close owner FD, then release relay. The current loop releases before the outer main finally; cleanup only in that finally is insufficient. Never release while handlers remain active.
- [ ] Run lifecycle/worker plus existing FlowPilot runtime/gateway and FILE tests, typecheck and diff check; require original legacy call counts and exact supervisor PASS guard preserved.
- [ ] Commit `feat(relay): start shared owner and preserve legacy reconciliation`.

### Task 13: Exact-source acceptance with real clients, locks and restart

**Files:** Create `tests/server/rbridge-core-acceptance.test.ts`, `tests/fixtures/rbridge-acceptance-owner.ts`, `docs/remote-bridge-v2-p2a.md`; update `README.md`, `docs/DEVELOPMENT_HISTORY.md`.

**Interfaces:** No new public API. Use assembled constructors, real sockets/flock/processes, actual SDK clients and trusted private fixture source roots. Fixture-only filesystem, root and helper overrides never come from tools, RPC or deployment inputs.

- [ ] Write `two stdio clients and GitHub converge on one operation` and `replacement owner preserves terminal truth`. One owner, independent modern/legacy stdio processes and authenticated GitHub submit the same ID concurrently; gate/count actual reads, compare receipts/output. Also test collisions, SIGKILL, queued/running cancel, lost acknowledgement, full storage, manifest mismatch/corruption and remote publication recovery with no terminal rerun.

```ts
// two stdio clients and GitHub converge on one operation
expect(readHandlerCalls).toBe(1);
expect(modernReceipt).toEqual(legacyReceipt);
expect(gitHubReceipt).toEqual(modernReceipt);
expect(reassembledOutputSha256).toBe(modernReceipt.resultSha256);
// replacement owner preserves terminal truth
expect(terminalHandlerCallsAfterRestart).toBe(0);
```

- [ ] Run `npm test -- tests/server/rbridge-core-acceptance.test.ts`; expect missing fixture behavior, not skipped OS cases.
- [ ] Complete fixture wiring and fix only exposed defects, adding a regression for each behavior change. Document actual API/actions/limits/UID boundary/IPC/persistence/query/cancel/failure recovery, later P2B–D and installation limits. Documentation never substitutes for observed acceptance.
- [ ] Run targeted acceptance/lock/IPC/SDK tests, full `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:server`, `git diff --check` and the exact `.github/workflows/local-first-ci.yml` public scrub on Node 22; require actual local results with any environment restriction reported explicitly.
- [ ] Commit `test(core): qualify shared P2A execution and recovery` and publish a draft implementation PR.
- [ ] Require canonical non-root CI on that exact reviewed synthetic merge tree; record actual SHA/tree/Node/test counts/kernel and socket outcomes, then obtain whole-branch review and update PR validation. Older documentation-only CI does not qualify implementation. Design/plan approval alone does not authorize merge or deployment.


## Acceptance coverage and execution handoff

| Approved design acceptance | Planned evidence |
| --- | --- |
| 1. Shared GitHub/MCP identity and collision | Tasks 4, 8, 10–13; actual three-ingress handler count and receipt comparison |
| 2. Two owners, helper death, owner death, child inheritance and persistent inode | Tasks 5, 6, 12, 13; real Linux processes/locks, no source-string proof |
| 3. Commit/crash/disk-full/corruption truth | Tasks 2, 3, 8, 9, 13; fault injection plus process restart |
| 4. Binding, scope, moved journal, legacy IDs and provenance | Tasks 1, 2, 4, 6, 10–13; negative admission/lookup tests |
| 5. Capacity, JSON/frame/cursor bounds, observation flood and revocation | Tasks 1–3, 6–9; known-ID read availability at exhausted capacity |
| 6. Real SDK read/result/block/cancel/reconnect semantics | Tasks 6, 9, 11, 13; exact phase chains and settled-handler cancellation |
| 7. Exact reviewed tree verification, separate live acceptance | Task 13 and existing CI; installation/deployment remains a later authorized action |

The four increments are sequential at their shared interfaces. Each task needs a failing behavioral test, minimal implementation, green targeted cycle and reviewable commit. Before implementing, confirm discovered existing test/document filenames and adapt their references without changing the acceptance requirement.

Recommended execution method is **Native** using `superpowers:executing-plans`: this work has tightly coupled identity/storage/cancellation interfaces and benefits from one implementing context. If the owner chooses **Subagent** instead, use `superpowers:subagent-driven-development` with the same ordered tasks and exact-tree verification. Review this written plan and select the method before starting product code. Neither choice authorizes a production release transition.
