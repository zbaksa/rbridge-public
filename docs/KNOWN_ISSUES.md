# Known issues and current limitations

## RB-001 — missing read-only FILE target remained pending

Status: **fixed in current public main**.

Earlier Stage-2 behavior could leave a read-only FILE request pending when the file port raised a real `ENOENT`.

Current behavior normalizes `ENOENT` only for read-only operations (`LIST`, `STAT`, `READ`, `READ_MANY`, `SEARCH`) to `REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND` and publishes a durable terminal `BLOCKED` result.

Regression coverage verifies terminalization, durable replay after worker recreation, recovery after result-publication failure without re-executing the read, preservation of `APPEND_TEXT` creation behavior, no broadening to `MOVE` failures, and no misclassification of persistence-layer `ENOENT`.

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
