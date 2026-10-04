# Roadmap

RBridge is functional today, but the public product surface is still pre-1.0.

This roadmap separates **implemented capabilities** from **future work**. It is directional, not a promise of dates.

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
- optional FlowPilot loopback ingress
- durable FlowPilot state/callback evidence
- exact-commit CI and public-source scrub
- MIT public repository

## Next — product usability

### 1. Portable installer

Goal: one supported installer that:

- creates/verifies runtime account;
- installs Node/runtime dependencies;
- renders systemd unit;
- prepares state permissions;
- verifies GitHub CLI auth;
- performs first HEALTH acceptance.

### 2. Deployment-neutral runtime paths

Some current process/controller integration paths come from the original deployment environment.

Goal:

- make executable/controller paths explicit deployment configuration;
- retain fail-closed validation;
- keep request payloads unable to control executable paths.

### 3. Profile packs

Goal: allow reviewed, source-controlled profile sets for common tasks without turning profiles into request-controlled commands.

Potential examples:

- safe Git inspection;
- bounded build/test;
- service health probes;
- application-specific diagnostics.

### 4. First-class examples/SDK

Goal:

- request-builder library;
- validated JSON examples;
- CLI helper for Issue creation/status;
- schema export.

### 5. Release packaging

Goal:

- signed/tagged releases;
- checksums;
- reproducible build guidance;
- install/upgrade tooling.

## Later — integrations

### MCP adapter

Expose selected RBridge capabilities as MCP tools while keeping RBridge's durable execution engine behind the adapter.

The adapter should not simply turn into "arbitrary shell over MCP".

### Additional transports

Potential ingress transports:

- authenticated HTTP;
- message queue;
- local Unix socket;
- workflow-system connectors.

Every transport must preserve the same normalized request identity and authorization model.

### Dashboard

Read-only/operational UI for:

- queue;
- sessions;
- transfers;
- durable request history;
- result states;
- release identity.

Mutation controls should remain explicit and audited.

### Broader platform support

Current public deployment is Linux/systemd-first.

Possible future work:

- macOS service packaging;
- Windows service/agent;
- containerized deployments.

The security model must be re-evaluated for each platform rather than assuming Linux filesystem/process semantics translate directly.

### Policy/approval layer

Optional policies for higher-risk operations:

- human approval;
- per-capability author roles;
- operation budgets;
- maintenance windows;
- signed request assertions.

## Non-goals

RBridge should not become:

- an unrestricted root shell;
- a hidden remote-access tool;
- a replacement for OS access controls;
- a product that silently guesses success after uncertain side effects.

New features should preserve the core invariant:

> More capability must not require less certainty or weaker authorization.
