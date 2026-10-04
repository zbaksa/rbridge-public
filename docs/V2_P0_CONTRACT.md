# RBridge 2.0 P0 — Contract & Security Freeze

Status: **P0 contract target**

RBridge 2.0 starts by freezing the execution contract before adding MCP or broader workstation capability.

The P0 rule is:

> **Transports may carry an operation. They may not define its identity, authorization, retry semantics or truth.**

This document is normative for the 2.0 implementation unless a later security-reviewed change explicitly updates it.

## 1. 2.0 release scope

RBridge **2.0.0 is a SAFE release**.

Included target:

- transport-neutral durable execution core;
- GitHub compatibility transport;
- MCP transport;
- HEALTH / FILE / PROCESS / CHUNK SAFE capabilities;
- queue/status/log/cancel/recovery observability;
- major cloud-client compatibility;
- free/open-client compatibility;
- at least one fully local/offline model path;
- installer, upgrade and rollback validation.

Not required for 2.0.0:

- WORKSTATION arbitrary developer-code execution;
- unrestricted shell;
- GUI/desktop control.

Planned sequencing:

- **2.0.0 — SAFE**
- **2.1 — WORKSTATION**, only after an isolated executor proves filesystem/network/secret/resource boundaries
- **later — FULL ACCESS**, explicit opt-in
- **later — GUI/desktop adapter**

## 2. One normalized operation identity

Every transport maps its authenticated request into the same core submission:

```text
RBRIDGE_OPERATION_SUBMISSION_V1
├── operationId
├── principalId
├── targetInstanceId
└── operation
```

The current TypeScript contract is in:

```text
src/domain/rbridgeExecutionContract.ts
```

### operationId

`operationId` is the durable identity key.

Rules:

- the same `operationId` plus the same intent may reconcile/replay;
- the same `operationId` plus a different intent is a collision and must fail closed;
- terminal work is never silently reopened;
- transport retries do not create a second execution identity.

### principalId

Transport-specific identities must be mapped to a stable deployment-controlled `principalId`.

Examples of raw evidence that **must not** become authorization by itself:

- a GitHub login string;
- an MCP client display name;
- a self-reported model/client name.

The transport authenticates. The deployment maps that evidence to a principal. The core authorizes the principal.

### targetInstanceId

The operation is bound to one target instance.

Moving a state directory to another target or changing deployment identity must not silently make an old receipt valid for the new target.

## 3. Intent digest

The core computes a canonical intent digest from:

- schema;
- principal;
- target instance;
- normalized operation.

The digest intentionally excludes transport metadata.

That lets the same already-known operation be reconciled through another transport without changing the operation's meaning.

Transport metadata remains audit evidence, but it is not permission.

Prototype-sensitive JSON argument keys (`__proto__`, `constructor`, `prototype`) are rejected at every nesting level before normalization or hashing. A key must not disappear from the canonical intent while leaving an inherited value visible to a handler. These names remain valid inside string values, including file contents.

## 4. Acceptance TTL is not execution TTL

A transport may impose a TTL on **initial acceptance**.

Once the core has durably claimed an operation, expiry of the original transport request does not erase the claim and does not stop reconciliation.

This directly preserves the V1 recovery fix:

> accepted durable work must remain trackable after the request's acceptance window has expired.

Execution lifetime is a separate bounded policy/profile concern.

## 5. SAFE capability boundary

The initial 2.0 normalized core permits only:

- `HEALTH`
- `FILE`
- `PROCESS`
- `CHUNK`

It does **not** include:

- `APP_RUN` in the new MCP SAFE surface;
- arbitrary executable paths;
- request-controlled shell commands;
- request-controlled filesystem roots;
- unrestricted developer-code execution.

Legacy transports may retain compatibility behavior while migration is in progress, but that does not automatically make legacy capability part of the new SAFE MCP surface.

### FILE

Policy/runtime must own allowed roots.

The request cannot expand roots.

Symlink/path-swap protection, secret-path policy, byte limits and atomic mutation rules remain host-side concerns.

### PROCESS

START selects a source-controlled process profile.

The request cannot select an executable path or shell command.

A PROCESS profile is not automatically safe merely because it is called a profile. Any future profile that can run general Python, Node, npm lifecycle scripts, Docker socket operations or equivalent arbitrary code requires the WORKSTATION isolation model rather than being smuggled into SAFE.

### Network and secrets

2.0 documentation must distinguish:

- **a capability that cannot request arbitrary network/code access**, from
- **a proven network sandbox**.

RBridge must not claim network isolation until it exists and is acceptance-tested.

Likewise, path deny-lists supplement least privilege; they are not a substitute for OS isolation when general code execution is enabled.

## 6. Durable phase graph

Core phases are monotonic:

```text
CLAIMED
  ├──> TERMINAL (for pre-execution BLOCKED)
  └──> AUTHORIZED
         ├──> TERMINAL
         └──> STARTING
                ├──> TERMINAL
                └──> RUNNING
                       └──> TERMINAL
```

A terminal operation cannot return to RUNNING.

`STARTING` is deliberately explicit because a crash at the side-effect boundary may require reconciliation.

## 7. Retry and uncertainty contract

RBridge does not promise universal exactly-once execution for arbitrary external side effects.

Instead:

1. read-only work may be retried when that is provably harmless;
2. identity-idempotent work may be reconciled by stable external identity;
3. mutating work is not blindly replayed after a point where its side effect may have occurred;
4. when the previous effect cannot be proved, the result is `UNCERTAIN`.

An `UNCERTAIN` result is a successful safety decision, not a guessed execution result.

Each mutating capability added after P0 must document its recovery strategy.

## 8. Cancel / STOP contract

Cancellation is an intent, not proof.

These statements are different and must remain separately observable:

1. **cancel requested**;
2. **managed process proven stopped**;
3. **previous side effects rolled back**.

The execution receipt therefore carries a cancellation state and a separate side-effect state.

`PROCESS_PROVEN_STOPPED` never means “all previous effects were undone”.

## 9. Execution receipt

The normalized receipt records:

- `operationId`;
- intent digest;
- principal;
- target instance;
- exact policy snapshot/version/hash;
- phase and terminal outcome;
- reason;
- result digest where applicable;
- cancellation evidence;
- side-effect state;
- phase transitions;
- postconditions.

A process exit code of zero is not, by itself, proof that the requested business outcome occurred.

Important profiles may define postconditions/artifact checks. Failed or unknown postconditions must not be rewritten as PASS.

## 10. Transport adapter requirements

Every ingress adapter — GitHub, MCP, future HTTP/queue/local socket — must:

1. authenticate its caller using transport-appropriate evidence;
2. map the caller to a stable configured principal;
3. normalize the request into the common operation contract;
4. use the same core claim/collision/replay state;
5. use the same policy evaluation;
6. use the same execution/recovery engine;
7. return core truth without inventing success.

A transport cannot gain authority by exposing a hidden tool name, guessed operation ID or alternate endpoint.

## 11. MCP compatibility target

P1 should use the current stable MCP TypeScript SDK line and explicitly support both protocol eras needed by real clients:

- modern `2026-07-28`;
- legacy 2025-era clients during migration.

The modern protocol removed the old per-session initialize model; compatibility logic belongs in the MCP adapter, not in the RBridge execution identity.

Official references:

- https://ts.sdk.modelcontextprotocol.io/v2/
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28

## 12. Security is a gate in every patch

Security qualification is not deferred to a final “security patch”.

Every P1+ change must state:

- capability added/changed;
- trust boundary changed or unchanged;
- replay/recovery behavior;
- negative tests;
- resource bounds;
- failure/uncertainty behavior.

No patch passes merely because its happy-path test is green.

## 13. V1 and V2 run in parallel

V2 source development may continue while the V1 production hotfix is being resolved.

However:

- V1 remains the accepted production baseline until its hotfix cutover is complete;
- the unresolved historical durable-state gate must not be deleted or reclassified merely to unblock deployment;
- V2 does not go to production until the V1 durable-state situation is explicitly resolved and the production baseline is understood.

## P0 exit criteria

P0 is complete when:

- this contract is merged;
- the TypeScript normalized contract is merged;
- negative contract tests are green;
- the V2 plan/roadmap reflect SAFE-only 2.0 sequencing;
- exact-commit CI is green;
- public-source scrub is green.

After that, P1 may implement MCP without changing the frozen authority/recovery model.
