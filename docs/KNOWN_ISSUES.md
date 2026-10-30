# Known issues and current limitations

## RB-001 — missing read-only FILE target remained pending

Status: **fixed in current public main**.

Earlier Stage-2 behavior could leave a read-only FILE request pending when the file port raised a real `ENOENT`.

Current behavior normalizes `ENOENT` only for read-only operations (`LIST`, `STAT`, `READ`, `READ_MANY`, `SEARCH`) to `REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND` and publishes a durable terminal `BLOCKED` result.

Regression coverage verifies terminalization, durable replay after worker recreation, recovery after result-publication failure without re-executing the read, preservation of `APPEND_TEXT` creation behavior, no broadening to `MOVE` failures, and no misclassification of persistence-layer `ENOENT`.

## RB-002 — durable cutover audit can produce false PASS

Status: **OPEN / RELEASE GO BLOCKED**. Tracked in [Issue #91](https://github.com/zbaksa/rbridge-public/issues/91). The issue concerns a read-only readiness audit; no actual data-loss or unsafe live deployment is established.

The existing `remoteBridgeDurableAudit.ts` can report `cutoverGate=PASS` for states that have not met an independently qualified release gate:

- A durable `CLAIMED` or `WAITING` request whose matching trusted GitHub Issue was closed, despite no durable admission/settlement evidence.
- A malformed durable `PUBLISHED` record without a persisted terminal result.
- An unexpired `OPEN` CHUNK transfer whose manifest is omitted from the audit snapshot and gate.

**Regression-first evidence:** [exact-head CI #41021102713](https://github.com/zbaksa/rbridge-public/actions/runs/41021102713) and [CI #41023440233](https://github.com/zbaksa/rbridge-public/actions/runs/41023440233) each produced exactly two intentionally failing *new* negative tests while 297 existing TypeScript tests passed. The test-only branches did not change runtime source. These four counterexamples prove the audit can misclassify such *synthetic fixtures*, not that any live operation was lost.

**Operational restriction:** do not treat a successful audit, a closed Issue or a successful source CI alone as permission to switch a running release. A protected cutover additionally requires bounded original-request identity and archival-set proof, verified writer quiescence, explicit CHUNK persistence/rollback compatibility, immutable artifact verification, and actual live acceptance. An unresolved historical request is not automatically successful. The runtime correction and its independent GREEN verification have **not** been completed; preserve existing state and maintain fail-closed policy.

## Current product limitations

These are not necessarily bugs; they describe the current pre-1.0 product boundary.

### Linux/systemd-first packaging

There is no supported Windows/macOS service package yet.

### No first-class installer

Installation currently requires building the source and rendering/deploying the systemd template manually.

### No MCP transport

RBridge is not currently an MCP server. MCP integration is roadmap work.

### Deployment-specific runtime paths remain in some profiles

The shipped process/controller integration retains runtime paths from the current Linux execution environment. New deployments must review them before enabling APP_RUN/PROCESS capabilities.

### FILE root is source-controlled

The default FILE root is `/mnt/data`; it is not a request-controlled or simple environment-configurable root.

### Controller broker required for APP_RUN execution

The controller adapter expects a compatible local broker. Deployments without it should not advertise APP_RUN.

### GitHub transport is polling-based

The public asynchronous transport trades low operational exposure for polling latency and GitHub API dependency.

See [Roadmap](ROADMAP.md) for planned productization work.
