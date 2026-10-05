# Shared durable core — P2A design draft

Status: **proposed architecture; owner review pending; no implementation or deployment**.

Source baseline: main `c69b30abfcc10085f688c4603733b73514045b62`, tree `ec8d851d828839df039a2f64c26d7ef7ef041edd`. [PR #30](https://github.com/zbaksa/rbridge-public/pull/30) preserves the existing supervisor PASS guard. Its [canonical CI](https://github.com/zbaksa/rbridge-public/actions/runs/37232551870) tested 286/286 tests on a synthetic PR merge with that exact tree. This design does not qualify an installation.

## Intent and scope

The existing P0 contract is authoritative: a transport carries an operation while the durable core owns identity, authorization, execution and truth. P1 supplies a real stdio adapter, but its production entrypoint still has no core. The requested continuation is to make GitHub and MCP converge on one durable SAFE execution identity without weakening the V1 baseline or replaying legacy work.

This draft recommends a first P2 deliverable that is independently useful: one durable owner, authenticated local access, shared GitHub/MCP admission, HEALTH and bounded read-only FILE execution, receipts, status and paged result access. It deliberately decomposes the remaining SAFE work:

| Deliverable | Boundary to establish before enabling it |
| --- | --- |
| P2A, specified here | Single writer, operation identity, read-only execution, recovery and transport convergence |
| P2B, separate design | Principal/target ownership of PROCESS sessions, START recovery, input and proven STOP |
| P2C, separate design | Principal/target ownership of CHUNK manifests and idempotent transfer recovery |
| P2D, separate design | Per-action recovery evidence for FILE mutations; no blind append/edit/move retry |

P2A alone is not RBridge 2.0 release acceptance. PROCESS, CHUNK and mutating FILE requests remain durably BLOCKED by policy while those later boundaries are unimplemented. No APP_RUN, shell, arbitrary module loading, remote HTTP authentication or network sandbox is added to MCP.

## Options and recommendation

| Option | Advantage | Cost or failure boundary |
| --- | --- | --- |
| One owner in the existing GitHub service; MCP is a local IPC client | One journal writer and one policy implementation; stdio restart cannot create a second executor | Requires bounded local IPC and a running service |
| Independent embedded cores in every ingress | No service dependency for stdio | Requires cross-process transactional claims, fencing and recovery before any effect; a PID file is insufficient |
| Reuse the existing V1 request store as the core | Small apparent change | V1 requires issue/job identity, lacks the P0 phases and receipts, and has no principal-scoped session/transfer ownership |

Recommend the first option. Keep the existing non-root runtime and existing relay exclusion, add a kernel-backed owner lock, and start IPC only after both exclusions are held. Legacy and core-backed ingress run in that same owner process. An old service holding the relay lock prevents a new owner from starting. MCP never executes locally when the service is unavailable.

The Linux owner lock is advisory; every supported writer must participate. Keep its inode rather than deleting a "stale" lock file. The proposed acquisition opens a validated lock FileHandle in the owner, invokes fixed `/usr/bin/flock -n 9` once with that same descriptor explicitly mapped to child fd9, and retains the owner handle until shutdown. The short-lived helper exits; there is no separate lock-holder parent whose death could orphan an unlocked owner. No handler/supervisor child receives this descriptor. This proposal follows documented [open-file-description lock semantics](https://man7.org/linux/man-pages/man2/flock.2.html), [fd-form flock](https://kernel.googlesource.com/pub/scm/utils/util-linux/util-linux/+/refs/tags/v2.41.1/sys-utils/flock.1.adoc) and [Node descriptor sharing](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html). It still requires real acquisition, contention, helper-kill, owner-SIGKILL and inheritance tests; no successful lock experiment is claimed here. Startup fails if the helper cannot prove acquisition. Require a persistent local Linux filesystem; network filesystems and ephemeral production journals are unsupported in P2A.

## Local trust and identity

P2A supports one deployment-configured principal per runtime account and target. This is an explicit local OS-account boundary, not isolation between hostile clients using the same account. Multiple principals sharing one UID and remote serving remain out of scope.

The owner derives the state root from the non-root runtime account. The IPC socket lives under a private `execution-v2` directory, mode 0700, with socket mode 0600. The owner validates every ancestor and refuses symlinked, foreign-owned or writable-by-others state entries. Before connect, the client checks the expected owner and socket type; the client cannot choose the socket path from a tool argument. Socket creation failure leaves execution unavailable. A stale socket is removed only after the owner lock is held and its type, owner and parent are validated.

The daemon assigns principal and target from its own deployment binding and requires submissions to match them. Client display names, caller-supplied transport labels, operation IDs and principal fields cannot change authority. IPC requests cannot claim GitHub provenance. The GitHub adapter resides in the owner and authenticates repository, author, title/body and initial acceptance TTL before constructing its context. MCP retains P1's non-root UID/runtime checks; its configured principal/target must match the owner handshake. Local metadata is audit evidence, not additional permission.

Root and compromise of the shared runtime account are outside this boundary. File permissions alone do not establish distinct trust domains for two clients running as that account. No kernel peer-credential guarantee is claimed by this design.

## Journal and operation identity

Use a new subtree without importing V1 records:

- `execution-v2/manifest.json`: schema, runtime UID, configured principal and target, journal version;
- `execution-v2/operations/<operationId>.json`: normalized submission, intent digest, revision, receipt and transport observations;
- `execution-v2/results/<operationId>.json`: bounded canonical output bytes and their SHA256;
- `execution-v2/deliveries/github/<issueNumber>.json`: publication progress, separate from execution phase;
- `execution-v2/owner.lock` and `execution-v2/core.sock`: local owner coordination.

An operation ID remains the durable key across transports. Principal and target are part of the existing intent digest, not a replacement identity namespace. The manifest prevents moving a journal to another target or silently changing principal. A matching ID and digest returns its known receipt; a different intent produces a known collision rejection without changing the original record. TERMINAL is immutable.

Before a new claim, reserve every operation ID already present in either legacy V1 request storage or the FlowPilot journal/tombstones. An old ID cannot be made new by choosing another transport or directory. Legacy claim creation also checks core reservations under the owner serializer. New core-backed GitHub delivery records use the separate delivery subtree and do not create a V1 claim with the same ID. Existing legacy jobs and receipts stay on their original engine; they are never reclassified as P0 receipts.

Validate existing files using nonblocking, no-follow descriptor reads, regular-file type, one link, expected owner, bounded size and canonical filename identity. Record writes use exclusive temporary files, file fsync, atomic rename and parent fsync. Recheck the expected revision before a transition. Only the owner writes journal files; per-operation serialization also prevents overlapping callbacks inside that process. A partial or corrupt record fails closed and is retained for diagnosis.

Retain terminal identity records and their output; P2A has no automatic history deletion or ID reuse. Bound audit observations to the first authenticated context per supported transport plus counters, not an ever-growing list of retries. Startup verifies bounded storage accounting from retained records. Capacity exhaustion rejects new claims without preventing status/result/replay for known IDs. Archiving or retention migration requires a separate design preserving identity reservations.

## Core interfaces

Define shared types in `src/domain/rbridgeCoreProtocol.ts`; retain the P0 normalized submission, policy and receipt types unchanged.

```ts
type RBridgeCoreSubmitResult =
  | {status:'RECEIPT'; receipt:RBridgeExecutionReceiptV1}
  | {status:'REJECTED'; reason:RBridgeCoreRejection;
     operationId:string; principalId:string; targetInstanceId:string};

type RBridgeCoreRejection =
  | 'RBRIDGE_CORE_INTENT_COLLISION'
  | 'RBRIDGE_CORE_SCOPE_INVALID'
  | 'RBRIDGE_CORE_LEGACY_ID_RESERVED'
  | 'RBRIDGE_CORE_CAPACITY_REACHED';

interface RBridgeCorePort {
  submit(submission:RBridgeOperationSubmissionV1,
    context:RBridgeTransportContextV1,
    signal:AbortSignal):Promise<RBridgeCoreSubmitResult>;
  status(operationId:string, context:RBridgeTransportContextV1):
    Promise<RBridgeCoreLookupResult>;
  result(operationId:string, cursor:number, maxBytes:number,
    context:RBridgeTransportContextV1):Promise<RBridgeCoreResultPage>;
  requestCancel(operationId:string, intentSha256:string,
    context:RBridgeTransportContextV1):Promise<RBridgeCoreCancellationResult>;
}
```

`RBridgeCoreLookupResult` is a scoped RECEIPT or NOT_FOUND response. It must never return another scope's stored receipt. `RBridgeCoreResultPage` carries the checked receipt, resultSha256, byte cursor, nextCursor, eof and base64 of the canonical output segment, or a scoped NOT_READY/NOT_FOUND response. The digest covers the complete canonical output file, not the individual page. An existing result must match the receipt digest before it can be served.

`RBridgeCoreCancellationResult` is scoped REQUESTED plus its current receipt, UNCHANGED_TERMINAL plus its unchanged receipt, NOT_FOUND, or REJECTED for a scope/intent mismatch. Acknowledging REQUESTED requires the cancellation field to be durably committed. It does not claim handler/process stoppage.

Known rejection is not a fabricated durable receipt and is not UNCERTAIN. An exception after delegation or an unusable receipt remains UNCERTAIN in the adapter, with no automatic retry. A caller reconciles by the original ID using status. Update P1's injected core interface to the discriminated result and keep the external `CORE_RECEIPT` wrapper for valid receipts; add explicit BLOCKED mapping for known rejections.

## Bounds and policy

| Boundary | P2A value |
| --- | --- |
| Submission JSON | 65,536 UTF-8 bytes; depth 16; nodes 4,096; prototype-sensitive keys rejected recursively |
| IPC | One request per connection; request 65,536 bytes; response 131,072 bytes; framing/error output bounded |
| Owner queue | At most 128 accepted, nonterminal operations; at most 4 concurrent handlers; existing ID lookup/replay still works at capacity |
| Durable storage | At most 10,000 operation identities and 10,000 delivery records; operation record at most 131,072 bytes; combined journal/delivery budget 67,108,864 bytes; combined result budget 536,870,912 bytes including staging files |
| Receipt | P0/P1 strict schema; at most 5 phase transitions and 128 postconditions |
| Canonical result file | At most 8,388,608 bytes including JSON/base64 overhead; no secret-bearing diagnostics |
| Result page | 1–32,768 bytes; integer cursor within the result; replaying the page does not execute work |
| FILE | Source-controlled `/mnt/data`; read 1,048,576 bytes; READ_MANY 1–32 relative paths and combined read limit; LIST 1–500 entries; SEARCH up to 500 matches |

Policy version is `safe-core-p2a-v1`. Its hash covers the enabled actions, roots, byte limits, identity binding rules and recovery rules using canonical JSON. The policy snapshot used for a claim is persisted in its receipt and is never replaced by a later policy during recovery. A stricter current policy may stop an incomplete operation; it cannot broaden the original authorization. Persist BLOCKED with a current-policy restriction reason and a postcondition hash proving that decision, retaining the original snapshot. A terminal operation is never reopened because policy changed.

Before admission reserve twice the maximum record and result sizes to cover one atomic replacement/staging copy. Release unused reservations only after a committed receipt/output accounts for their actual bytes. Unknown or abandoned staging files count against the budgets at recovery; they cannot vanish from accounting. The aggregate budget may reject new work before the queue limit is reached. A new GitHub delivery at capacity reports publication unavailable while retaining the original execution receipt; it never executes again. Existing status/result/replay remains available without allocating new identity or delivery records.

Enabled actions are HEALTH/STATUS and FILE/LIST, STAT, READ, READ_MANY, READ_BINARY and SEARCH. The action-specific validator accepts only the existing handler's named arguments; requests cannot widen roots or select executable paths. Unsupported SAFE actions get a persisted BLOCK policy receipt, CLAIMED→TERMINAL, BLOCKED, sideEffects NONE_PROVEN. Admission errors, unauthorized scope, collision and capacity rejection happen before claim and have no receipt.

`rbridge_capabilities` keeps the contract kinds and additionally reports trusted `enabledActions` and the connected core status. A connected P2A core must not imply that PROCESS, CHUNK or FILE mutations execute.

## Execution, recovery and cancellation

For allowed read-only work, persist CLAIMED and AUTHORIZED before entering the accepted queue. Submit returns the current durable receipt without waiting for terminal execution; callers use status/result to observe completion. The owner later persists STARTING, RUNNING and TERMINAL in order. The handler is invoked only after STARTING is durable. Successful bounded output is canonically stored and fsynced before the terminal receipt commits its digest. A failed output commit cannot be reported as PASS. Postconditions prove that the requested read completed within policy and that stored output matches its digest; an exit code alone is not used.

During recovery, terminal work returns the same receipt/output without invoking the handler. For an incomplete P2A read, harmless re-observation is permitted because the action has no requested mutation; the final output describes that actual observation, not the abandoned earlier snapshot. No such rule applies to later mutating actions. P2B–D must each define external identity and uncertainty before enabling them.

An AbortSignal aborted before admission creates no claim. For accepted queued work, serialize cancel intent behind any admission commit: AUTHORIZED→TERMINAL, outcome TERMINATED, policy ALLOW, sideEffects NONE_PROVEN, cancellation REQUESTED; the handler is never dispatched. Do not use CLAIMED→TERMINAL/TERMINATED. That short transition remains exclusively the existing policy BLOCKED receipt. A cancellation of running read work becomes TERMINATED only after its bounded handler has stopped. If verified completion wins the race, its terminal receipt remains immutable.

The one-request IPC protocol has separate BINDING, SUBMIT, STATUS, RESULT and CANCEL_INTENT RPCs; BINDING is the owner handshake on its own connection. CANCEL_INTENT carries operationId and intentSha256; the owner derives scope, validates the digest and commits REQUESTED under the operation serializer. A collided submission's cancellation cannot affect the winning different intent. MCP adds `rbridge_cancel` with those two fields; an AbortSignal during an in-flight submit attempts at most one separate CANCEL_INTENT RPC, without retrying SUBMIT. A dropped connection itself is only transport loss. If acceptance or cancel acknowledgement is unknown, return UNCERTAIN and reconcile STATUS using the original ID after reconnect; NOT_FOUND does not promise that a concurrently arriving submit will never be accepted. A known accepted queue entry honors its durable cancellation before dispatch.

P2A never reports PROCESS_PROVEN_STOPPED or ROLLED_BACK. Acceptance TTL expiry does not discard an existing claim, prevent status/result/cancel reads or stop reconciliation. Late cancellation of terminal work returns UNCHANGED_TERMINAL and cannot rewrite its receipt/output.

## Transport and file boundaries

The GitHub SAFE path authenticates before delegating, uses requestId as operationId and maps the configured subject to the same principal/target as MCP. Publishing to GitHub is a separate durable delivery attempt. Publication failure cannot rerun the operation or rewrite its receipt. An issue identity/body change is a delivery identity failure; a fresh issue is not permission to reinterpret the operation.

The stdio entrypoint obtains a bounded IPC client rather than an embedded executor. The owner handshake supplies the journal schema, configured binding and policy hash. A missing owner, wrong binding or invalid response is explicit failure; no local fallback or request-controlled core module is loaded. Add `rbridge_status`, `rbridge_result` and `rbridge_cancel`; none is a second execution-admission path. Stdio stdout remains MCP protocol only, and owner diagnostics remain sanitized.

Reuse the existing descriptor-based FILE handler with its source policy and secret-path rules. P2A adds action-specific argument validation and verified bounded output; it does not widen roots. Tests must retain real parent-directory/symlink swap cases, secret-path rejection, FIFO rejection, missing-file behavior, binary handling and combined READ_MANY limits.

## Component map and delivery sequence

| File | Responsibility |
| --- | --- |
| `src/domain/rbridgeCoreProtocol.ts` | Core result, lookup and result-page envelopes; shared JSON and framing bounds |
| `src/server/rbridgeExecutionJournal.ts` | Manifest, durable claims, monotonic CAS transitions and result-file verification |
| `src/server/rbridgeExecutionPolicy.ts` | Fixed P2A policy, action-specific arguments and exact policy snapshot |
| `src/server/rbridgeExecutionCore.ts` | Admission, serializer, bounded scheduling, read execution and reconciliation |
| `src/server/rbridgeCoreIpc.ts` | Private bounded socket server/client; deployment binding handshake |
| `src/adapters/rbridgeGitHubCore.ts` | Trusted SAFE normalization and separate publication progress |
| `src/server/rbridgeMcpSafe.ts` / `rbridgeMcpMain.ts` | Inject the IPC port, validate known results, expose status/result/cancel and enabled actions |
| `src/server/remoteBridgeMain.ts` / `remoteBridgeWorker.ts` | Start the one owner after locks, route SAFE requests, preserve legacy reservations |
| `src/server/rbridgeOwnerLock.ts` | Validated FileHandle, fixed fd-form flock acquisition and owner-lifetime release |

After design approval, the implementation plan should form four reviewable increments: journal/policy, owner/IPC, read execution/recovery, and both transport integrations. Each increment needs regression-first tests and a meaningful complete test cycle. Source tests should exercise real processes and persisted files, not inspect strings for implementation details.

## Acceptance evidence

1. Two independent stdio clients and GitHub submitting the same ID/intent result in one read-handler invocation and the same receipt. Different intents cannot alter the winner.
2. Two independent owners cannot both acquire ownership. Kill the short-lived acquisition helper and the owner at each acquisition boundary; require failure before IPC if acquisition is unconfirmed. Killing an acquired owner releases its lock, while a live supervisor/handler child does not retain it. A replacement owner reconciles persisted work without deleting the lock inode. Reject unsupported filesystem/ownership conditions.
3. Crash injection at claim, phase commit, result fsync and terminal commit yields retained truth, harmless read recovery or explicit uncertainty; no guessed PASS. Disk-full/write-error/corrupt-file tests retain evidence.
4. Changing principal/target, moving a journal, reusing any legacy/FlowPilot ID, and requesting another caller's result all fail closed. Caller-supplied transport labels grant no authority.
5. Queue/storage capacity rejection does not block existing operation reconciliation. Oversized/deep input, unknown fields, unsafe JSON keys, huge result frames and hostile cursors are bounded. Retry floods cannot grow observation history without bound. Policy revocation blocks incomplete execution without rewriting the original policy or reopening terminal work.
6. Actual modern and legacy SDK stdio clients discover enabled actions, execute a bounded read, retrieve/verify its output, observe explicit unsupported-action BLOCKED and reconnect by the same ID after transport cancellation. Queued cancellation has exactly CLAIMED/AUTHORIZED/TERMINAL, policy ALLOW, outcome TERMINATED and no handler call; policy denial keeps the short BLOCKED path. Cancel an unknown admission, lost acknowledgement and collided intent without false stoppage or modifying the winning intent.
7. Full typecheck, targeted and complete tests, lint, server build, diff check and public-source scrub pass on the exact reviewed source tree. Live deployment, OS boundary acceptance and final 2.0 release claims remain separate.

## Review decisions still requiring the owner

Approve or revise the single owner plus local IPC architecture, the initial one-principal-per-runtime-account boundary, and the P2A read-only increment before implementation planning. The broader P0 SAFE target remains unchanged. The next step after written-design approval is a written implementation plan with exact task tests and an execution-method choice. This document authorizes no code execution or production transition.
