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

For a consistent offline backup:

1. stop RBridge;
2. copy the state root while preserving permissions;
3. restart RBridge;
4. run a fresh HEALTH request.

Example:

```bash
sudo systemctl stop rbridge.service
sudo cp -a /home/rbridge/.local/state/rbridge /backup/location/
sudo systemctl start rbridge.service
```

Do not use a casual recursive copy as a live-state migration while the service is mutating records.

## Upgrade

### V1 durable-scope migration note

Current V1 hotfixes bind newly claimed durable requests to repository + trusted author + target instance. Older durable records do not contain that scope.

Before upgrading from an older unscoped release:

- ensure there are no in-flight `CLAIMED` or `SUBMITTED` requests that must be resumed by the new release;
- preserve the old state as backup;
- expect attempts to replay old unscoped request IDs to fail closed with a scope mismatch;
- use new request IDs for new work after upgrade.

This is intentional: silently trusting an old record after repository/author/target identity changes would reintroduce the replay problem.

Recommended release workflow:

1. identify exact candidate SHA;
2. run `npm ci --ignore-scripts`;
3. run `npm run verify`;
4. confirm CI for the exact SHA;
5. stage a new immutable release directory;
6. leave durable state in place;
7. update the `current` symlink atomically;
8. restart RBridge;
9. run HEALTH and capability-specific canaries;
10. keep the old release until acceptance is complete.

Avoid overwriting an existing immutable release directory.

## Rollback

If a new release fails acceptance:

1. stop the new service process;
2. point `current` back to the previous known-good release;
3. restore deployment environment only if it changed;
4. restart;
5. run HEALTH;
6. inspect durable state before retrying any operation that may have executed.

The last point matters: durable state may contain valid work produced before a later acceptance failure.

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
