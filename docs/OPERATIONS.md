# Operations

This guide covers day-to-day operation of a deployed RBridge service.

## Service status

For systemd deployments:

```bash
systemctl status rbridge.service
systemctl is-active rbridge.service
systemctl is-enabled rbridge.service
```

A healthy steady state is normally:

```text
active
enabled
```

## Logs

RBridge logs structured JSON to stdout/stderr, so systemd deployments can inspect it with:

```bash
journalctl -u rbridge.service -n 200 --no-pager
journalctl -u rbridge.service -f
```

Typical logs include structured tick records and fatal-error records.

Do not treat a single transient tick error as proof that the process is dead; the main loop applies bounded backoff and continues unless the service itself exits.

## Health

The preferred external health check is a V2 `HEALTH / STATUS` request.

A healthy snapshot reports:

- `status: PASS`
- current release SHA;
- non-negative queue/session/transfer counts;
- last GitHub poll timestamp once polling has occurred.

The health response intentionally omits sensitive internal configuration.

## Durable state

Default state root:

```text
~/.local/state/rbridge
```

Important subtrees include request state, process sessions and transfers.

### Backup

For a consistent offline backup, maintain exclusion, stop admissions and independently observe that the service, alternate writers, process sessions and owned helper families have settled. A successful `systemctl stop` acknowledgement alone does not prove this.

Copy the complete stopped state into a protected create-only destination. Retain unknown names and historical hardlink evidence; never delete or repair them to make a gate pass. Preserve original state bytes and metadata. Verify the full backup manifest, directory ownership/inodes and copied bytes independently both before and after publication. Reading the backup for verification must preserve its recorded timestamps.

Restart only through the approved recovery or installation decision for the observed state. A casual recursive copy followed by an unconditional start does not provide P2A maintenance qualification.

## Upgrade

### V1 durable-scope migration note

Current V1 hotfixes bind newly claimed durable requests to repository + trusted author + target instance. Older durable records do not contain that scope.

Before upgrading from an older unscoped release:

- ensure there are no in-flight `CLAIMED` or `SUBMITTED` requests that must be resumed by the new release;
- preserve the old state as backup;
- expect attempts to replay old unscoped request IDs to fail closed with a scope mismatch;
- use new request IDs for new work after upgrade.

This is intentional: silently trusting an old record after repository/author/target identity changes would reintroduce the replay problem.

Release preparation:

1. identify exact candidate SHA;
2. run `npm ci --ignore-scripts`;
3. run `npm run verify`;
4. confirm CI for the exact SHA;
5. stage and independently verify the complete immutable release and its locked dependencies;
6. qualify the exact final runtime/toolkit, actual readers and isolated privileged fixtures;
7. retain durable state and record the reviewed bundle, original configuration and current pointer.

Changing the service requires a complete qualified command and separate explicit switch authorization. The maintained pause, five stopped-state gates, configuration/pointer CAS and installed acceptance sequence are described in [Installation](INSTALLATION.md). Keep the original release and every transaction record throughout recovery.

Avoid overwriting an existing immutable release directory.

## Rollback

P2A recovery depends on whether a start was attempted, including an attempted start whose acknowledgement was lost or failed.

Before `START_ATTEMPTED`, the transaction may restore only its exact owned configuration additions and pointer change after independently rechecking ownership, exclusion, the snapshot and compatible gates. It leaves the service stopped. A concurrent original-file edit, replaced object, unknown writer or uncertain durable intent blocks restoration and retains the evidence.

At or after `START_ATTEMPTED`, do not return to the old pointer, restore an old state snapshot, restart the old service or clear publication/operation history. The candidate may already have admitted work. Stop it through the concrete host backend, prove the service and all writers/helpers have settled, and preserve all current state, manifests, receipts and configuration for compatible recovery. Missing settlement remains `HOLD_UNSETTLED`.

## Maintenance resume and result meanings

A lock is held by the current foreground process only; it does not survive process death. A new process must freshly acquire exclusion and inspect the complete private maintenance registry. An unfinished predecessor, active peer lock, corrupt ledger, partial backup or unknown helper object blocks a new transaction. Resume uses the exact existing transaction ledger and full private evidence; a missing ledger or lock is never initialized as recovery.

Each fixed Root helper also records a create-only private `helper-<32hex>` journal before launch, including helpers used during qualification before any transaction exists. Its intent, observed process identity and settlement records form a digest chain. A missing record, active journal lock or interrupted write blocks the next cold launch and is preserved for investigation. Complete records still require fresh kernel absence. Only the same foreground producer can nest fixed observations after re-examining its retained process family; this exception does not survive its death. These journals authorize no service action and are never automatically repaired or removed.

| Transaction exit | Meaning |
| --- | --- |
| `0` / `ACCEPTED` | Fresh final invocation and complete installed acceptance were recorded |
| `2` / `BLOCKED`, `UNKNOWN` or `HOLD_UNSETTLED` | Preconditions, durable ownership or observed settlement are incomplete; inspect the reason codes and preserve the hold |
| `3` / `RESTORED_PRE_START_STOPPED` | Exact owned changes were restored before any start attempt; the service remains stopped |
| `4` / `STOPPED_POST_START_HOLD` | Post-start stop and writer/helper settlement were observed; the old restart remains forbidden |

These are transaction outcomes, not generic meanings for every reader/audit CLI exit. A durable `ACCEPTED` marker alone does not provide fresh live acceptance. A status read reports ledger history and explicitly leaves live state unobserved.

The foreground CLI retains exclusion for its bounded owner-present window after a failed transaction. When that window ends, it leaves durable evidence and reports that fresh reacquisition is required. It never promises a surviving flock. The bootstrap wrapper preserves the child/sudo exit status without exiting the interactive parent shell; shell liveness alone is not a successful installation result.

The current Native qualification/bootstrap handoff refuses Root command readiness while physical qualification remains unperformed. The Source driver requires genuine cold custody, authenticated bootstrap bytes and authenticated owner review of the entire command/input before executing a fresh protected copy. A direct entry invocation or serialized review cannot substitute its private review origin. Source fixtures and CI can pass while actual artifact, reader, import-closure or privileged qualification remains `UNKNOWN`. Do not assemble a production command from draft components or serialized PASS reports.

## GitHub transport housekeeping

RBridge processes only open request Issues matching the configured author/title prefix.

Operational checks:

```bash
gh issue list --repo owner/control-repo --state open
gh issue list --repo owner/control-repo --state closed --limit 20
```

If requests accumulate:

- check service status;
- check `gh auth status` under the runtime user;
- inspect rate-limit/transport errors;
- check whether requests are expired or malformed.

## GitHub API/rate limiting

The main loop recognizes rate-limit-like failures and increases backoff up to the configured loop maximum.

A rate-limited tick should not cause unbounded hot polling.

## Process sessions

PROCESS sessions are durable. If the main RBridge loop restarts, session state is reconciled rather than assumed lost.

When an operation reports uncertainty:

- do not submit a new START under a different requestId merely to "try again";
- first inspect the original session/request result;
- use STATUS/READ_OUTPUT when a session identity exists;
- preserve durable state during investigation.

## Transfer cleanup

Open CHUNK transfers have expiration. Completed manifests may remain as durable history depending on retention/cleanup behavior of the release.

If disk usage matters, inspect the transfer subtree and application retention policy. Do not manually delete individual chunks from an active transfer.

## Windmill orchestration

When Windmill drives RBridge through GitHub Issues, troubleshoot the two sides independently:

- Windmill flow/job state should show whether the request Issue was created;
- the Issue author must match `RBRIDGE_GITHUB_AUTHOR`;
- the Issue body/title must satisfy the normal RBridge V2 contract;
- RBridge should publish a structured result and close the Issue;
- Windmill should poll/read that result rather than resubmit side effects blindly.

Keep the Windmill GitHub credential in a Windmill secret/resource and scope it to the control repository as narrowly as practical.

See [Windmill integration](WINDMILL.md).

## Disk permissions

Recommended state ownership:

```text
runtime-user:runtime-group
directories 0700
files       0600
```

The service's `UMask=0077` template reinforces restrictive defaults.

## Monitoring ideas

Useful operational signals:

- service active state;
- restart count;
- release SHA from HEALTH;
- queue count;
- active session count;
- active transfer count;
- age of last GitHub poll;
- number/age of open request Issues;
- age/state of Windmill flow runs that are waiting on RBridge results.

RBridge does not currently ship a Prometheus exporter; integrate these checks with your monitoring system as appropriate.

## Durable-state cutover audit

Before a release that changes durable identity/scope semantics, use the read-only audit utility:

```bash
node dist/server/server/remoteBridgeDurableAudit.js \
  --state-root /path/to/rbridge-state \
  --repository owner/control-repo \
  --author trusted-github-login
```

The utility does **not** mutate state or GitHub Issues. It:

- classifies `CLAIMED`, `SUBMITTED` and unpublished `TERMINAL` durable records;
- verifies the corresponding GitHub Issue is the expected request, author and repository;
- distinguishes trusted `OPEN` unresolved work from historical `CLOSED` records;
- counts active PROCESS sessions;
- returns `cutoverGate: PASS|BLOCKED|UNKNOWN`.

A `CLOSED` historical durable record is not automatically rewritten or deleted. It remains evidence. A future replay under a different scope must still fail closed.

Audit evidence is fail-closed: missing/malformed session records, orphaned START claims, invalid durable digests or filenames, symlinked evidence and changes to the observed state tree cannot produce PASS. `UNCERTAIN` process state blocks cutover because it does not prove the process stopped. GitHub lookups have a bounded timeout and concurrency.

The CLI always writes its JSON report to stdout, including structural `UNKNOWN` failures. Exit codes are `0` for PASS, `4` for BLOCKED, `3` for lookup UNKNOWN and `2` for invalid/unreadable/changing evidence. Check both the exit code and `cutoverGate`; `auditStatus: PASS` only means the audit completed, not that cutover is permitted.

A read-only audit is an observation, not an execution lock. Its before/after state fingerprint detects changes during observation but does not prevent later writes or Issue edits. Quiesce all state writers and admission paths, repeat the audit immediately before cutover, and keep them quiesced through the switch. Do not reuse an earlier live audit as deployment authorization.
