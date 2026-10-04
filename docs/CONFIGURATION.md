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

### `RBRIDGE_INSTANCE_ID` — optional explicit target identity

RBridge binds new durable request records to the configured GitHub repository, trusted author and target instance.

If `RBRIDGE_INSTANCE_ID` is set, it must be a short safe identifier and is used as the target-instance identity.

If it is not set, the Linux runtime derives the instance identity from `/etc/machine-id`.

This binding prevents a state directory from silently replaying a result after the control repository/author changes or after state is moved to a different target instance.


## Durable state

State root is derived as:

```text
<runtime-user-home>/.local/state/rbridge
```

The public main process uses subtrees for:

- request store;
- process sessions;
- chunk transfers;

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

`APP_RUN` execution uses the controller client.

The public adapter's default Unix socket is:

```text
/run/ai-tool-fabric/controller-broker.sock
```

A deployment that does not provide a compatible broker can still use base capabilities that do not require controller execution (for example HEALTH and bounded host FILE/PROCESS/CHUNK operations), but `APP_RUN` will not work.

This broker path is currently source-defined, not environment-configurable in the public main entry point.

## Windmill orchestration

Windmill does not require a Windmill-specific RBridge environment variable. The recommended public integration uses the same GitHub Issue transport as any other RBridge client.

Configure RBridge normally with its trusted GitHub repository and author. In Windmill, keep the GitHub token in a Windmill secret/resource and use it to create/poll request Issues.

See [Windmill integration](WINDMILL.md).

## Example environment file

Base-only:

```text
RBRIDGE_RUNTIME_USER=rbridge
RBRIDGE_RELEASE_SHA=<40-hex-sha>
RBRIDGE_GITHUB_REPOSITORY=owner/control-repo
RBRIDGE_GITHUB_AUTHOR=trusted-login
```

Never commit the secret-bearing environment file.
