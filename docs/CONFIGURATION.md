# Configuration reference

RBridge keeps deployment identity outside the public source. The runtime reads a small set of environment variables and derives durable state from the runtime account.

## Base runtime

### `RBRIDGE_RUNTIME_USER` — required

Exact OS username that is allowed to run the service.

The process refuses:

- UID 0;
- a username that does not match this value;
- a root/invalid home directory.

Example:

```text
RBRIDGE_RUNTIME_USER=rbridge
```

### `RBRIDGE_GITHUB_REPOSITORY` — required

GitHub control repository in `owner/repository` form.

Example:

```text
RBRIDGE_GITHUB_REPOSITORY=example/rbridge-control
```

Requests from other repositories are rejected.

### `RBRIDGE_GITHUB_AUTHOR` — required

Exact trusted GitHub login that may author request Issues.

Example:

```text
RBRIDGE_GITHUB_AUTHOR=automation-owner
```

### `RBRIDGE_RELEASE_SHA` — required for valid HEALTH

40-character lowercase/hex Git commit identifying the deployed source release.

A legacy fallback variable, `COCWIN_REMOTE_BRIDGE_RELEASE_SHA`, is still read by the source for compatibility, but new deployments should use `RBRIDGE_RELEASE_SHA`.

## Durable state

State root is derived as:

```text
<runtime-user-home>/.local/state/rbridge
```

The public main process uses subtrees for:

- request store;
- process sessions;
- chunk transfers;
- optional FlowPilot bridge state.

The current main entry point does not expose a request-controlled state-root override.

## GitHub CLI

The GitHub adapter currently invokes:

```text
/usr/bin/gh
```

The runtime user's GitHub CLI credential context must therefore be configured and able to:

- list open Issues in the control repository;
- view Issue comments;
- add comments;
- close completed Issues.

## Source-controlled host policy

These are **not environment variables** in the current public release; they are release/source properties.

### FILE

Current default allowed root:

```text
/mnt/data
```

Current profile:

- max read: 1 MiB;
- max search results: 500.

### PROCESS

Current allowed profile IDs:

- `git-read`
- `node-safe`
- `stdin-echo`

Current cwd root:

```text
/mnt/data
```

Review `src/domain/remoteBridgeHostProfiles.ts` because executable paths are part of the release.

### CHUNK

The host profile is bounded, while the current main-process chunk-store defaults are stricter:

- default chunk-store max chunk: 40,000 bytes;
- default total transfer: 8,000,000 bytes;
- default max chunks: 256.

Do not assume a looser client-side value will be accepted.

## Controller broker

`APP_RUN` and FlowPilot execution use the controller client.

The public adapter's default Unix socket is:

```text
/run/ai-tool-fabric/controller-broker.sock
```

A deployment that does not provide a compatible broker can still use base capabilities that do not require controller execution (for example HEALTH and bounded host FILE/PROCESS/CHUNK operations), but `APP_RUN` and FlowPilot controller actions will not work.

This broker path is currently source-defined, not environment-configurable in the public main entry point.

## Optional FlowPilot configuration

FlowPilot ingress is opt-in.

### `COCWIN_FLOWPILOT_INGRESS_ENABLED`

Set exactly:

```text
true
```

to enable the ingress.

If absent or any other value, the runtime does not start FlowPilot ingress.

### `FLOWPILOT_REMOTE_BRIDGE_TOKEN`

Required when ingress is enabled.

Constraints:

- string;
- at least 32 characters;
- no whitespace.

### `FLOWPILOT_CALLBACK_TOKEN`

Required when ingress is enabled.

Same minimum constraints as above, and it **must differ** from `FLOWPILOT_REMOTE_BRIDGE_TOKEN`.

### `COCWIN_FLOWPILOT_CALLBACK_URL`

Default:

```text
http://127.0.0.1:8097/api/v1/executor/callback
```

Validated by the callback client.

### `COCWIN_FLOWPILOT_INGRESS_HOST`

Default:

```text
127.0.0.1
```

Only literal loopback values are accepted:

- `127.0.0.1`
- `::1`

### `COCWIN_FLOWPILOT_INGRESS_PORT`

Default:

```text
8098
```

Production configuration requires a valid TCP port 1-65535.

### `RBRIDGE_COCWIN_POLICY_URL`

Used by the current COCWIN-specific FlowPilot policy/refresh/qualification execution profiles.

The URL validator requires:

- `http:` scheme;
- no username/password;
- valid hostname;
- exact path `/api/v1/automation-engine/policy`;
- no query string;
- no fragment.

Public RBridge does not hard-code a private deployment IP into the compiled source; deployment provides this URL.

## Example environment file

Base-only:

```text
RBRIDGE_RUNTIME_USER=rbridge
RBRIDGE_RELEASE_SHA=<40-hex-sha>
RBRIDGE_GITHUB_REPOSITORY=owner/control-repo
RBRIDGE_GITHUB_AUTHOR=trusted-login
```

With FlowPilot:

```text
RBRIDGE_RUNTIME_USER=rbridge
RBRIDGE_RELEASE_SHA=<40-hex-sha>
RBRIDGE_GITHUB_REPOSITORY=owner/control-repo
RBRIDGE_GITHUB_AUTHOR=trusted-login

COCWIN_FLOWPILOT_INGRESS_ENABLED=true
COCWIN_FLOWPILOT_INGRESS_HOST=127.0.0.1
COCWIN_FLOWPILOT_INGRESS_PORT=8098
COCWIN_FLOWPILOT_CALLBACK_URL=http://127.0.0.1:8097/api/v1/executor/callback
FLOWPILOT_REMOTE_BRIDGE_TOKEN=<secret-at-least-32-chars>
FLOWPILOT_CALLBACK_TOKEN=<different-secret-at-least-32-chars>
RBRIDGE_COCWIN_POLICY_URL=http://example.internal:8088/api/v1/automation-engine/policy
```

Never commit the secret-bearing environment file.
