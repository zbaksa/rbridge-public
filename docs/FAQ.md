# FAQ

## What is RBridge in one sentence?

RBridge is a fail-closed remote execution gateway that lets authorized automation request **bounded, durable operations** on a Linux host without exposing a generic request-controlled shell.

## Is RBridge an MCP server?

Not today.

RBridge has its own GitHub Issue V2 transport and an optional FlowPilot loopback ingress. A future MCP adapter is on the roadmap, but the current public product should not be configured as though it already speaks MCP.

## Why not just use Desktop Commander?

Desktop Commander is excellent for interactive AI-assisted computer use and is MCP-native. It intentionally exposes rich terminal/file/process tools to a trusted AI client.

RBridge is optimized for a different problem: autonomous/scheduled operations where source-controlled capabilities, durable request identity, replay/collision protection and explicit uncertainty semantics matter.

See [Comparison](COMPARISON.md).

## Why not just use SSH?

SSH is the right tool for secure remote login and trusted admin command execution.

RBridge adds an application-level contract on top of the host:

- request identity;
- exact schema;
- TTL;
- source-controlled profiles;
- durable phases;
- replay/collision semantics;
- structured result/evidence.

Use SSH for operators and RBridge for bounded automation if that division fits your system.

## Does RBridge require COCWIN?

The base GitHub V2 transport does **not** require COCWIN.

Some wire/schema names retain `COCWIN_...` prefixes for compatibility with the project's original lineage.

The optional FlowPilot integration currently contains COCWIN-specific actions that require deployment configuration if you choose to use them.

## Does RBridge require FlowPilot?

No.

FlowPilot ingress is disabled unless explicitly enabled.

## Does RBridge require the controller broker?

Only capabilities routed through controller execution require it:

- `APP_RUN`;
- current FlowPilot action execution.

Base HEALTH/FILE/PROCESS/CHUNK host capabilities are implemented separately.

## Can RBridge run as root?

No. The public main runtime explicitly rejects UID 0.

Use a dedicated non-root account.

## Can a request run any command?

No.

PROCESS START selects a source-controlled profile. Requests cannot provide an executable path.

APP_RUN is a separate controller-mediated capability and has its own bounded payload/tool contract.

## What files can it access?

The current public source-controlled FILE root is:

```text
/mnt/data
```

The file adapter also rejects symlink traversal and common secret-bearing paths/names.

## Can I change the allowed file root?

Today the default root is source-controlled in the release, not request-controlled and not exposed as a simple runtime environment override.

You can maintain a reviewed fork/release policy, but changing roots is security-sensitive.

A more portable profile/configuration mechanism is on the roadmap.

## What happens if I retry the same request?

If the same `requestId` has the same canonical request digest, RBridge can treat it as replay.

If the same requestId is reused with different content, RBridge reports a collision instead of silently changing meaning.

## What does UNKNOWN mean?

RBridge cannot safely prove whether an operation succeeded or failed.

This is different from FAIL. It exists to stop automation from blindly repeating a side effect that may already have happened.

## Why use GitHub Issues as a transport?

It provides:

- authenticated internet-reachable control without opening an inbound RBridge port;
- human-readable request/result history;
- persistent asynchronous queue semantics.

Trade-offs are polling latency and GitHub dependency/rate limits.

## Does RBridge have a GUI?

No dedicated GUI today.

The current product is service/API/automation oriented. An operational dashboard is a roadmap item.

## Does it support Windows or macOS?

The public deployment is Linux/systemd-first today.

Broader platform packaging is future work.

## How do I know exactly what version is running?

Set `RBRIDGE_RELEASE_SHA` to the exact deployed Git SHA and query HEALTH.

Treat source/CI identity and live deployment acceptance as separate evidence.

## Where should I start?

1. [Quick Start](QUICKSTART.md)
2. [Security model](SECURITY_MODEL.md)
3. [Installation](INSTALLATION.md)
4. [Protocol](PROTOCOL.md)
