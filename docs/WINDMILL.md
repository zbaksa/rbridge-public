# Windmill integration

Windmill is the recommended **public workflow/orchestration layer** for RBridge.

RBridge does not require Windmill, and Windmill does not need a special RBridge plugin. The clean public integration uses RBridge's existing GitHub Issue request/result transport:

```text
Windmill flow
   |
   | create authorized RBridge request Issue
   v
GitHub control repository
   |
   | RBridge polls, validates, durably claims and executes
   v
RBridge host
   |
   | structured result comment + Issue close
   v
GitHub control repository
   |
   | Windmill polls/reads result
   v
next workflow step
```

This design keeps one public RBridge contract regardless of whether the caller is a human, a script, CI, or Windmill.

## Why Windmill fits RBridge

Windmill provides scripts, flows, schedules, webhooks, resources/secrets and monitoring. Its GitHub integration can be stored as a workspace resource and passed to scripts/flows.

That makes Windmill useful for:

- scheduled RBridge health checks;
- periodic FILE/PROCESS tasks;
- multi-step automation that waits for an RBridge result;
- fan-out/fan-in workflows across multiple RBridge hosts/control repositories;
- retrying **polling/status steps** without blindly repeating side effects;
- dashboards/internal apps around RBridge results.

## Licensing note

Windmill has multiple licensing surfaces.

At the time this guide was written:

- the source build without enterprise features is open source under AGPLv3;
- Windmill's self-hosted free/open-source offering supports unlimited executions;
- the distributed Community Edition has additional license terms, especially around redistribution, resale, managed service use, modification/wrapping and embedding.

If RBridge is simply calling Windmill or Windmill is using RBridge internally, this is very different from redistributing/embedding Windmill as part of a commercial product. Review Windmill's current license and pricing terms for your use case.

Official references:

- https://github.com/windmill-labs/windmill
- https://www.windmill.dev/docs/advanced/self_host
- https://www.windmill.dev/docs/integrations/github
- https://www.windmill.dev/pricing

## Recommended architecture

Use a dedicated GitHub control repository for RBridge requests/results.

In Windmill, configure a GitHub OAuth/resource or another least-privilege GitHub credential that can:

- create Issues in the control repository;
- read Issues/comments;
- optionally query Issue state.

RBridge independently uses its own runtime GitHub credential to:

- list authorized open request Issues;
- publish result comments;
- close completed Issues.

The author identity of the Windmill-created Issue must match `RBRIDGE_GITHUB_AUTHOR`.

## Flow pattern

A robust Windmill flow should separate **side-effect creation** from **result polling**.

### Step A — build one RBridge request

Generate:

- a unique `requestId`;
- current canonical UTC `createdAt`;
- an `expiresAt` no more than 30 minutes later;
- one valid RBridge V2 operation.

Use the exact title/schema literals documented in [Protocol reference](PROTOCOL.md). Some current wire strings retain legacy compatibility prefixes; treat them as opaque protocol constants, not product dependencies.

### Step B — create the GitHub Issue exactly once

The step should return at least:

```json
{
  "requestId": "windmill.health.20261004T120000Z",
  "issueNumber": 123
}
```

Do not let a generic Windmill retry generate a different Issue for the same intended side effect unless your workflow explicitly decides to create new work.

### Step C — poll the same Issue

A retryable polling step reads the existing Issue/comments.

Stop when:

- a valid RBridge result comment exists; or
- the bounded workflow timeout is reached.

The polling timeout should fit inside the request TTL.

### Step D — branch on RBridge status

Treat statuses differently:

- `PASS` — continue success path;
- `FAIL` — operation definitely failed;
- `BLOCKED` — policy/validation/authorization prevented the operation;
- `UNKNOWN` — do **not** blindly replay a side effect; escalate/reconcile first.

This distinction is one of the main reasons to keep RBridge's execution contract in front of the workflow engine.

## Example: scheduled HEALTH flow

A simple Windmill flow can:

1. schedule every 5 minutes;
2. create a fresh RBridge HEALTH request;
3. poll its Issue;
4. parse the structured result;
5. fail/notify if:
   - no result before timeout;
   - status is not PASS;
   - release SHA is unexpected;
   - queue/session/transfer counts cross your chosen threshold.

HEALTH is a good first integration because it proves the full GitHub request/result path without granting file/process access.

## Example: bounded FILE workflow

A Windmill flow might:

1. create a FILE READ request;
2. wait for result;
3. parse returned text;
4. run validation/transformation in Windmill;
5. optionally create a separate EDIT_EXACT/WRITE request.

Keep reads and writes as separate requestIds so each side effect has a clear durable identity.

## Example: PROCESS workflow

For a supported source-controlled process profile:

1. create PROCESS START;
2. store returned session identity/owner digest;
3. poll STATUS or READ_OUTPUT;
4. optionally WRITE_INPUT only if that profile permits it;
5. TERMINATE if the workflow decides to stop early.

Do not model PROCESS as "run arbitrary shell". The profile boundary belongs to RBridge.

## Windmill secrets

Store GitHub credentials in Windmill resources/secrets, not inline source.

Recommended:

- dedicated GitHub identity or narrowly scoped token;
- access only to the RBridge control repository when practical;
- rotate/revoke independently from the RBridge host credential;
- do not print tokens in job logs;
- do not copy RBridge host secrets into Windmill unless a specific integration requires them.

## Retries

Windmill retries are useful, but side effects require discipline.

Safe to retry in many designs:

- reading an existing Issue;
- polling comments;
- parsing/validating an already-published result.

Potentially unsafe to retry blindly:

- creating a new semantic RBridge request with a new requestId;
- starting a process again after an uncertain result;
- repeating a write under a different durable identity.

Prefer idempotent workflow structure around RBridge's existing replay/collision model.

## Webhooks vs polling

RBridge's public transport currently polls GitHub, and Windmill can poll the Issue result.

A future integration could reduce latency with webhooks or a dedicated adapter, but it should preserve the same normalized request identity, TTL, authorization and durable execution semantics.

## Does RBridge embed Windmill?

No.

Windmill remains a separate public orchestrator. This avoids forcing Windmill licensing/packaging decisions on RBridge users and keeps RBridge usable from other automation systems.

## Related docs

- [Quick Start](QUICKSTART.md)
- [Protocol](PROTOCOL.md)
- [Security model](SECURITY_MODEL.md)
- [Operations](OPERATIONS.md)
- [Troubleshooting](TROUBLESHOOTING.md)
