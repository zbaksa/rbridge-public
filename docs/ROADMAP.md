# Roadmap

RBridge is functional today, and the next major product milestone is **RBridge 2.0.0**.

See the full plan: **[RBridge 2.0.0 Plan](V2_PLAN.md)**.

This roadmap separates implemented capabilities from future work. It is directional, not a promise of dates.

## Now — implemented

- GitHub Issue request/result transport
- V2 exact-schema request parser
- explicit repository/author trust root
- APP_RUN / FILE / PROCESS / CHUNK / HEALTH operations
- source-controlled file/process host profiles
- durable request state
- replay and collision protection
- durable process sessions
- chunk transfer integrity and manifests
- health snapshot
- explicit BLOCKED/UNKNOWN handling
- large result publication via chunked Issue comments
- systemd hardening template
- Windmill orchestration guide over the public GitHub transport
- exact-commit CI and public-source scrub
- MIT public repository

## RBridge 2.0.0 — primary next milestone

**2.0.0 is a SAFE release.** WORKSTATION moves to 2.1 after isolation is proven; FULL ACCESS and GUI remain later work.

See **[V2 P0 Contract & Security Freeze](V2_P0_CONTRACT.md)**.

### P0 — contract & security freeze

Freeze transport-neutral operation identity, trust scope, recovery/uncertainty semantics, cancel evidence, execution receipts and the SAFE capability boundary.

### P1 — MCP SAFE foundation

Add MCP without creating a second authorization/retry model. Support the modern 2026-07-28 era plus required legacy compatibility for tested clients.

### P2 — SAFE capability mapping

Expose bounded HEALTH, FILE, source-controlled PROCESS and transfer operations through the same durable core. Do not expose arbitrary shell/general APP_RUN in the new SAFE MCP surface.

### P3 — control & recovery surface

Add queue/status/log/cancel visibility with explicit evidence semantics, fair scheduling and bounded concurrency.

### P4 — compatibility qualification

Test major cloud clients, free/open clients and a fully local/offline path. Security/negative tests remain mandatory in every patch.

### P5 — packaging & productization

- portable installer;
- upgrade/rollback tooling;
- Desktop Commander migration guide;
- Windmill templates/helpers;
- AI/client compatibility matrix;
- optional funding/donation surface once real accounts are configured.

Core functionality remains free/open-source and donations do not unlock hidden capabilities.

### P6 — release qualification

Clean-machine installation, upgrade/rollback, exact-commit CI, security gates, durability/recovery demo and live acceptance. V2 production promotion remains blocked until unresolved V1 durable-state/cutover work is explicitly resolved.

### P7 — launch & adoption

Large-scale promotion starts only after 2.0.0 passes source, security, installation and live-acceptance gates.

Launch package:

- GitHub Release/tag + checksums/release notes;
- short product demo;
- durability/recovery demo;
- Desktop Commander migration guide;
- tested AI/MCP/free/local compatibility matrix;
- GitHub-first launch, then developer communities, self-hosted/automation communities, migration-focused outreach, and finally broader Product Hunt/social launch;
- post-launch fixes and compatibility results published as ongoing proof.

V1 remains available for early adopters, but the coordinated public launch is reserved for V2.0.0.

## Additional product usability

### Deployment-neutral runtime paths

Make executable/controller paths explicit deployment configuration while keeping them outside request control.

### Profile packs

Add reviewed source-controlled profiles for common development/diagnostic work.

### First-class examples/SDK

- request-builder library;
- validated JSON examples;
- CLI helper;
- schema export.

### Release packaging

- signed/tagged releases;
- checksums;
- reproducible build guidance;
- install/upgrade tooling.

## After 2.0

### RBridge 2.1 — WORKSTATION

Broader developer-code execution only through a proven isolated executor with explicit filesystem, network, secret and resource boundaries.

### Later — FULL ACCESS

Explicit unrestricted-shell opt-in for users who consciously accept the reduced command-level boundary.

## Later — integrations

### Additional transports

Potential ingress transports:

- authenticated HTTP;
- message queue;
- local Unix socket;
- workflow-system connectors.

Every transport must preserve the same normalized request identity and authorization model.

### Dashboard

Read-only/operational UI for queue, sessions, transfers, durable request history, result states and release identity.

Mutation controls should remain explicit and audited.

### GUI / desktop adapter

Potential optional capabilities:

- screenshots;
- mouse;
- keyboard;
- clipboard;
- window/application focus;
- multi-monitor support.

Desktop control is not a 2.0 launch requirement and should remain separately enabled.

### Broader platform support

Current public deployment is Linux/systemd-first.

Possible future work:

- macOS service packaging;
- Windows service/agent;
- containerized deployments.

### Policy/approval layer

Optional policies for higher-risk operations:

- human approval;
- per-capability author roles;
- operation budgets;
- maintenance windows;
- signed request assertions.

## Non-goals

RBridge should not become:

- an unrestricted root shell by default;
- a hidden remote-access tool;
- a replacement for OS access controls;
- a product tied to one AI vendor;
- a product that silently guesses success after uncertain side effects.

New features should preserve the core invariant:

> **More capability must be explicit, auditable, and opt-in; it must not weaken SAFE mode.**
