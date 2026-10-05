# Shared read-only execution core (P2A)

P2A connects GitHub and local MCP stdio to one durable owner in `remoteBridgeMain`. The owner shares normalized intent, deployment scope, policy, storage, scheduling and receipts. The MCP entrypoint connects to this owner; it never starts another executor. This implementation is a draft source increment tracked in [PR #32](https://github.com/zbaksa/rbridge-public/pull/32), with installation and live deployment qualified separately.

The frozen [P0 contract](V2_P0_CONTRACT.md), [approved design](superpowers/specs/2026-10-04-shared-core-p2a-design.md) and [implementation plan](superpowers/plans/2026-10-05-shared-core-p2a.md) remain authoritative. [P1 MCP notes](MCP.md) describe the earlier transport foundation; the connected behavior below applies to this P2A source.

## Enabled behavior and legacy continuity

| Request | P2A route |
| --- | --- |
| New SAFE HEALTH/STATUS | Shared core; bounded operational snapshot |
| New SAFE FILE/LIST, STAT, READ, READ_MANY, READ_BINARY, SEARCH | Shared core; fixed `/mnt/data` policy and bounded reads |
| New SAFE FILE mutation, PROCESS or CHUNK | Persisted policy BLOCK receipt; no effect handler |
| Existing legacy V1/V2 relay record | Original engine, scope, digest and publication behavior; no adoption into core |
| V1 or V2 APP_RUN | Legacy controller path, guarded against a core-reserved ID |
| FlowPilot ingress and reconciliation | Existing gateway/store and controller semantics, with the common core identity claim guard |

A FlowPilot journal or tombstone also reserves its ID against new core claims. A FlowPilot-only reservation cannot become a fresh legacy relay claim. Malformed or unsafe reservations fail closed. Unscoped legacy records retain their existing scope-mismatch failure; P2A does not repair, relabel, prune or execute them as new core work.

Only HEALTH and six FILE actions are enabled in P2A. `supportedKinds` includes FILE, HEALTH, PROCESS and CHUNK because these are schema forms; `enabledActions` is the authenticated owner’s executable subset. P2B–D cover later mutations, process lifecycle and large transfer execution. They are not enabled by a capability label or this draft.

## Runtime identity and startup

Use Node.js 22.x and a dedicated non-root Linux account. Real/effective UID and verified OS username must agree with `RBRIDGE_RUNTIME_USER`. Both entrypoints require explicit lowercase P0 IDs in `RBRIDGE_MCP_PRINCIPAL_ID` and `RBRIDGE_INSTANCE_ID`; there is no P2A machine-ID fallback for this binding. GitHub service configuration also requires `RBRIDGE_GITHUB_REPOSITORY`, `RBRIDGE_GITHUB_AUTHOR`, authenticated `/usr/bin/gh` under the runtime account and the existing release SHA configuration.

The owner derives its state from verified OS homedir. Tool arguments, RPC, model/client display names and MCP metadata cannot select the principal, target, policy, executor or storage root. A same-UID process can use the local socket; this is an OS-account trust boundary, not per-client authentication or an OS sandbox. Protect the runtime account and its deployment configuration.

| Location under verified homedir | Purpose |
| --- | --- |
| `.local/state/rbridge/relay.lock` | Existing legacy relay exclusion |
| `.local/state/rbridge/` legacy records, `flowpilot/`, `sessions/`, `transfers/` | Existing state, on its original engine |
| `.local/state/rbridge/execution-v2/owner.lock` | Persistent inode with an owner-retained Linux flock descriptor |
| `execution-v2/manifest.json` | Exact runtime UID, principal, target and journal schema binding |
| `execution-v2/operations/<operationId>.json` | Durable claim, original policy document, observations and receipt |
| `execution-v2/results/<operationId>.json` | Canonical verified output bytes |
| `execution-v2/deliveries/github/<issueNumber>.json` | Independent publication identity and progress |
| `execution-v2/core.sock` | Private one-request-per-connection Unix socket |

Directories are private 0700 and state files 0600, owned by the runtime UID; ancestors must be root/runtime-owned and not group/other-writable. Descriptor walks reject symlinks, FIFOs, wrong file types, links, wrong ownership and unsafe modes. Existing evidence is not chmodded or healed to satisfy validation. Production journals require a persistent local ext4, XFS or Btrfs filesystem; network and ephemeral journal filesystems are unsupported. Private temporary test roots and IO hooks are trusted fixture inputs only.

Startup validates configuration, acquires legacy exclusion and then owner flock before journal/recovery/IPC and guarded legacy initialization. The fixed `/usr/bin/flock -n 9` helper receives only the explicitly shared lock descriptor; the owner retains it after the helper exits. Supported handler/supervisor children do not inherit it. Partial startup retains failed bytes and closes only safely settled resources.

An existing relay lock is inspected through a nonblocking, no-follow descriptor before reading at most 32 bytes of PID text. Unsafe type, UID, mode, hard links or oversized metadata refuse startup and remain evidence; a complete, private stale PID retains the existing inode-checked reclamation behavior.

Shutdown stops ingress and IPC, waits for real core work and FlowPilot stop, then closes the owner descriptor and releases the legacy relay lock. A deadline, disconnected client or abort signal does not prove an outstanding IO operation settled. Exclusion remains while actual work is pending.

## MCP tools and response semantics

Configure the MCP client to launch `node` with the absolute built path `dist/server/server/rbridgeMcpMain.js` and the three identity environment variables above. Start the bound GitHub owner first. Modern and legacy official SDK stdio clients are supported; stdout contains protocol only and diagnostics use fixed stderr codes.

| Tool | Arguments | Result |
| --- | --- | --- |
| `rbridge_capabilities` | `{}` | Fresh checked owner binding, policy SHA and enabled actions; owner loss clears executable capabilities |
| `rbridge_submit` | `operationId`, normalized SAFE `operation` | `CORE_RECEIPT` for a validated durable receipt; known pre-claim rejection is `BLOCKED` without a receipt |
| `rbridge_status` | `operationId` | Scoped tagged lookup: `RECEIPT`, `NOT_FOUND` or `REJECTED` |
| `rbridge_result` | `operationId`, integer `cursor`, integer `maxBytes` | `RESULT` byte page, `NOT_READY`, `NOT_FOUND` or `REJECTED` |
| `rbridge_cancel` | `operationId`, original `intentSha256` | Durable cancellation intent or checked unchanged/rejected/not-found result |

Status/result/cancel responses use `RBRIDGE_MCP_CORE_QUERY_RESULT_V1` with a checked `result`. A core-connected submit uses `RBRIDGE_MCP_SUBMISSION_RESULT_V1`. Valid preflight rejection allocates no fake receipt. An unusable delegated response, lost acknowledgement or exception is `UNCERTAIN`; the client does not automatically retry SUBMIT. If SUBMIT may have been sent, the IPC client makes at most one independent cancellation attempt with the original digest, including when its submit signal is already aborted.

A file-read submission, for example:

```json
{"operationId":"read-example-1","operation":{"kind":"FILE","action":"READ","target":"/mnt/data/example.txt","args":{}}}
```

Principal and target are added by the trusted adapter. Poll `rbridge_status` until terminal, then fetch result pages. Each page contains `dataBase64`, `cursor`, `nextCursor`, `eof`, the terminal receipt and whole-output SHA256. The owner verifies the complete stored file for every page. Concatenate the decoded bytes in cursor order, verify the complete SHA256 and only then decode UTF-8/JSON; cursor offsets are bytes, not character positions. Queries cannot create a claim or replace output.

## Durable truth, cancellation and restart

The key is `(operationId, principalId, targetInstanceId)` with a canonical normalized intent digest. A matching authenticated retry observes the same claim; a changed intent under that ID is rejected before handler execution. First authenticated provenance per supported transport and saturating counters are bounded. Terminal records and output are immutable and IDs are not reused.

Allowed work commits CLAIMED and AUTHORIZED before submit acknowledgement. The scheduler writes STARTING and RUNNING before invoking a read handler; execution is outside the per-ID serializer. Verified canonical output is persisted and read back before a terminal PASS commits its digest and postconditions. Output/record fsync or integrity failure cannot acknowledge PASS. Temporary or corrupt bytes are retained and consume storage accounting.

Disabled operations commit CLAIMED→TERMINAL, BLOCKED, original BLOCK policy and `NONE_PROVEN` side effects. Unauthorized scope, malformed input, ID collision, legacy reservation and capacity rejection happen before claim and have no receipt.

Cancellation first persists REQUESTED under the same ID serializer and then signals outside that lease. Queued work terminalizes only after proving non-dispatch. Running reads terminalize only after the real handler/IO settles. A verified completion that wins the immutable terminal transition can remain the final outcome. P2A read cancellation can prove `NONE_PROVEN`; it does not claim process stoppage, rollback or removal of previous effects.

Recovery verifies the exact manifest, records, snapshots and bounded accounting before ingress. Incomplete allowed reads can be reobserved under the intersection of original and current policy; original claim evidence is retained. Persisted cancellation is honored. Terminal operations are never rerun or rewritten. Scope mismatch or corrupt state refuses startup and retains evidence. There is no automatic history deletion, adoption, retention migration or mutation retry.

## GitHub carrier and independent delivery

New SAFE requests retain the `COCWIN_REMOTE_BRIDGE_REQUEST_V2` issue envelope and title prefix. The adapter authenticates repository URL, author, issue identity, current title/body and bounds before semantic hashing or claim. TTL/open-issue checks apply to new acceptance; known core identity and pending delivery can be reconciled after expiry or closure.

Core execution and publication have separate durable records. Delivery freezes issue/title/body/request/intent identity and checks fresh remote identity before each publication step. A terminal core result is reconstructed from independently verified pages. The existing V2 outer envelope carries `RBRIDGE_GITHUB_CORE_RESULT_V1` with the inner receipt/output. The outer envelope/result hash and receipt’s canonical output hash serve different purposes.

Small results use a verified result comment. Large publication uses bounded SHA-checked chunks and a final manifest; at most eight missing chunks are written per pass. Authenticated existing comment bytes resolve lost write/close acknowledgements without re-execution or duplicate receipt publication. History and page counts are bounded. Identity changes block pending publication rather than replace its frozen identity. A remote publication failure never routes new SAFE back to legacy execution.

Every poll drains up to20 pending deliveries independently of the open-issue list, including when listing fails. The approved adapter reports CORE or publication-unavailable, so a tick can transiently count an immediately published new claim as pending; journal and delivery records carry the execution/publication truth.

## Fixed limits

| Resource | Limit |
| --- | --- |
| Submission/request frame | 65,536 bytes; JSON depth16, 4,096 nodes |
| RPC response / durable record | 131,072 bytes each |
| IPC resources | 64 live or unsettled request slots; socket closure/timeout does not free unsettled work |
| Incomplete operations / active handlers | 128 independent ceiling / four handlers |
| Default concurrent accepted reservations |32, constrained by aggregate worst-case output/staging reservation before the independent128 ceiling |
| Retained identities / deliveries / state entries |10,000 each /40,000 total entries |
| Journal / result storage |64MiB /512MiB, including retained staging bytes and reserved capacity |
| Canonical output / result page |8MiB /32,768 bytes |
| Source read / READ_MANY paths |1MiB aggregate /32 paths |
| LIST entries / SEARCH matches |500 /500 |
| Scanned entries / search depth |10,000 /32 |
| Frame / RPC / read-handler deadlines |5s /10s /10s, with real settlement still required |

Known status/result/replay remain available when new-claim reservation capacity is exhausted. Durability corruption still fails closed. These bounds do not promise host isolation from another process with the same UID or an administrator.

IPC closes a completed or rejected transport after flushing its response, with a 5s maximum flush wait. Peer EOF is not required to reclaim an idle connection; a delegated request still retains its slot until actual work settles. Pending GitHub delivery batches rotate by issue number with an owner-local cursor, so permanently unavailable carriers cannot monopolize repeated passes. Restart resets that cursor; frozen delivery identities and publication evidence are unchanged.

## Verification and installation boundary

Tests exercise the assembled owner in a separate process, real kernel flock/Unix sockets, two independent modern/legacy official SDK stdio processes, authenticated GitHub convergence, one actual source read, SIGKILL/replacement, immutable terminal replay, queued/running/lost-ACK cancellation, default capacity exhaustion, ENOSPC injection and corrupt/mismatched state. IPC regressions hold an actual journal descriptor after a real read to check disconnected-work capacity and close settlement. Publication and IO fault ports are explicit fixtures; these are source acceptance, not live GitHub or deployment results.

Exact source/tree and synthetic PR merge evidence, supported Node22, full test counts and required checks are recorded in the implementation PR. A root-only development environment cannot qualify positive runtime cases by relaxing UID checks; the dedicated non-root Linux runner executes those cases without skips.

The P1-era installation templates do not automatically install this source increment. A separately authorized installation must supply matching owner/MCP identity, reviewed persistent storage and permissions, executable helpers, policy roots and the appropriate runtime GitHub account. Review existing durable state and the release transition before any service change. Design/plan approval and source CI do not authorize merge or production deployment.
