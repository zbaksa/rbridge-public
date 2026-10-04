# RBridge

[![CI](https://github.com/zbaksa/rbridge-public/actions/workflows/local-first-ci.yml/badge.svg?branch=main)](https://github.com/zbaksa/rbridge-public/actions/workflows/local-first-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=white)](package.json)

**RBridge is a durable, fail-closed execution bridge for AI agents and automation.**

It lets an authorized automation system request work on a real Linux host without turning that host into an unrestricted remote shell. Requests are schema-validated, identity-bound, time-bounded, mapped to source-controlled capabilities, journaled durably, and returned as structured results.

> **Mental model:** SSH gives a trusted operator a remote shell. Desktop Commander gives a trusted AI client broad MCP tools for terminal and files. RBridge gives automation a **narrow execution contract** with durable state, replay/collision protection, bounded capabilities, and auditable evidence.

## Why RBridge?

AI agents are useful when they can act, but direct machine access creates a hard security and reliability problem. A generic shell is flexible, yet difficult to constrain, replay safely, or audit as a workflow.

RBridge is designed around the opposite default:

- **fail closed** when identity, schema, path, state, or execution certainty is ambiguous;
- **no generic request-controlled shell**;
- **source-controlled host and process profiles**;
- **durable request identity**, replay and collision detection;
- **bounded file, process, transfer, timeout, and output limits**;
- **structured PASS / FAIL / BLOCKED / UNKNOWN outcomes**;
- **GitHub Issue request/result transport** for asynchronous remote automation;
- optional **loopback FlowPilot ingress** for low-latency workflow execution;
- systemd hardening and a dedicated non-root runtime identity.

## Current status

RBridge is public under the MIT license. The current codebase is **pre-1.0**: the security and durability model is implemented and covered by CI, while packaging, installers, additional transports, and broader platform support are still evolving.

A source checkout never grants machine access by itself. Every deployment must configure its own runtime identity, trusted GitHub repository/author, credentials, filesystem permissions, and optional execution broker.

## What it can do

| Capability | Current behavior |
|---|---|
| Application execution | Submit/status/result through a compatible controller broker using bounded tool payloads |
| File operations | List, stat, read, multi-read, binary read/write, text write/append, exact edit, move and search |
| Process sessions | Durable START / STATUS / READ_OUTPUT / WRITE_INPUT / TERMINATE lifecycle |
| Large transfers | Chunk PUT / GET / FINALIZE with SHA-256 verification and durable manifests |
| Health | Safe operational snapshot: release, uptime, queue/session/transfer counts and last GitHub poll |
| Durable requests | Persistent phase/state, replay after restart, collision detection |
| GitHub transport | Poll authorized Issues, publish structured result comments, close completed requests |
| FlowPilot bridge | Optional loopback ingress with authenticated callbacks and durable operation state |
| Evidence | Deterministic result digests and action-specific FlowPilot evidence |
| Failure semantics | Distinguishes terminal failure, authorization block, and uncertain execution |

See [Protocol reference](docs/PROTOCOL.md) for the exact public wire contract.

## RBridge vs Desktop Commander, SSH and generic MCP servers

RBridge is **not trying to replace every remote-control tool**.

| | RBridge | Desktop Commander | SSH | Generic MCP server |
|---|---|---|---|---|
| Primary goal | Controlled, durable automation execution | Give a trusted AI client rich local/remote computer tools | Secure remote login/command transport | Expose tools/resources/prompts to AI clients |
| Generic shell by default | **No** | Terminal execution is a core feature | **Yes** | Depends on server |
| Request schema + TTL | **Yes** | Tool schemas, product-specific controls | No workflow schema | Tool input schemas |
| Durable replay/collision journal | **Core design** | Not an RBridge-style request journal contract | No | Implementation-specific |
| Source-controlled process profiles | **Yes** | Configurable terminal permissions/guardrails | No | Implementation-specific |
| Structured execution certainty | PASS / FAIL / BLOCKED / UNKNOWN | Tool result/error model | Exit status / transport errors | Tool result/error model |
| Headless Linux service | **Primary deployment** | Supported, but product is MCP/client-oriented | Yes | Depends on server |
| MCP-native today | No | **Yes** | No | **Yes** |
| Best fit | Autonomous or scheduled automation where replay/audit boundaries matter | Interactive AI-assisted computer use | Human/admin remote access | Connecting AI hosts to app-specific tools |

For a detailed and sourced comparison, see [RBridge compared](docs/COMPARISON.md).

## 5-minute Quick Start

### 1. Prerequisites

- Linux
- Node.js **22.x** (the package currently declares `>=22 <23`)
- npm
- GitHub CLI (`gh`) authenticated to a repository you control
- a **non-root** runtime user

### 2. Build and verify

```bash
git clone https://github.com/zbaksa/rbridge-public.git
cd rbridge-public
npm ci --ignore-scripts
npm run verify
```

### 3. Configure a foreground development instance

```bash
export RBRIDGE_RUNTIME_USER="$(id -un)"
export RBRIDGE_GITHUB_REPOSITORY="YOUR_GITHUB_LOGIN/YOUR_CONTROL_REPO"
export RBRIDGE_GITHUB_AUTHOR="YOUR_GITHUB_LOGIN"
export RBRIDGE_RELEASE_SHA="$(git rev-parse HEAD)"

node dist/server/server/remoteBridgeMain.js
```

RBridge will poll only the configured repository and only requests authored by the configured login.

### 4. Send a health request

Create an Issue in the configured control repository with title:

```text
[COCWIN BRIDGE REQUEST] demo.health.1
```

and body:

```json
{
  "schema": "COCWIN_REMOTE_BRIDGE_REQUEST_V2",
  "requestId": "demo.health.1",
  "createdAt": "2026-10-04T12:00:00.000Z",
  "expiresAt": "2026-10-04T12:10:00.000Z",
  "operation": {
    "kind": "HEALTH",
    "action": "STATUS"
  }
}
```

Use fresh canonical UTC timestamps when you try it: requests expire, and V2 TTL is capped at 30 minutes.

RBridge publishes the structured result as an Issue comment and closes a completed request.

> The `COCWIN_...` schema and Issue-prefix names are retained for wire compatibility with the original deployment lineage. They are protocol identifiers, not a requirement that a base RBridge deployment run COCWIN.

Full walkthrough: **[Quick Start](docs/QUICKSTART.md)**.

## Documentation

- [Quick Start](docs/QUICKSTART.md) — first successful request
- [Installation](docs/INSTALLATION.md) — production-style Linux/systemd deployment
- [Architecture](docs/ARCHITECTURE.md) — components, trust boundaries and data flow
- [Security model](docs/SECURITY_MODEL.md) — what RBridge does and does not protect
- [Configuration](docs/CONFIGURATION.md) — environment variables and deployment dependencies
- [Protocol reference](docs/PROTOCOL.md) — V2 request operations and constraints
- [FlowPilot integration](docs/FLOWPILOT.md) — optional loopback workflow ingress
- [Operations](docs/OPERATIONS.md) — health, logs, upgrade, backup and rollback
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common error codes and recovery
- [Comparison](docs/COMPARISON.md) — Desktop Commander, SSH and MCP
- [Roadmap](docs/ROADMAP.md) — now / next / later
- [FAQ](docs/FAQ.md) — common product and deployment questions
- [Known issues](docs/KNOWN_ISSUES.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Security in one minute

RBridge should run as a dedicated non-root account. The public implementation:

- requires an exact configured GitHub repository and author;
- rejects malformed, stale and oversized requests;
- prevents request-controlled executable paths for process sessions;
- confines default file operations to source-controlled roots;
- rejects symlink traversal and a set of common secret-bearing paths;
- hashes binary data and chunk transfers;
- persists request state before/reliably around side effects;
- treats uncertain process execution as **UNCERTAIN/UNKNOWN**, not a guessed success/failure;
- provides a hardened systemd template with `NoNewPrivileges`, an empty capability bounding set, read-only home/system protections, and a private temp directory.

RBridge is still privileged-adjacent software. A compromised trusted GitHub account or an over-privileged runtime user can cause harm within the configured capabilities. Read [SECURITY.md](SECURITY.md) and [the security model](docs/SECURITY_MODEL.md) before deployment.

## Important deployment boundaries

The public repository currently targets **Linux/systemd**.

The base GitHub transport can serve HEALTH, FILE, PROCESS and CHUNK operations without enabling FlowPilot. Some capabilities have additional deployment dependencies:

- `APP_RUN` uses a compatible controller broker at the controller socket expected by the source.
- FlowPilot ingress is optional and requires its own tokens/callback configuration.
- current built-in PROCESS profiles include runtime-specific executable paths; review [Configuration](docs/CONFIGURATION.md) before enabling them on a new host.
- the default source-controlled FILE root is `/mnt/data`.

These constraints are intentionally documented rather than hidden; making packaging and profiles more portable is on the roadmap.

## Development verification

The release-quality verification command is:

```bash
npm run verify
```

CI additionally performs a public-source scrub and exact-commit verification. Security-sensitive changes should include negative tests proving denied identities, paths, process inputs and ambiguous state still fail closed.

## License

[MIT](LICENSE)
