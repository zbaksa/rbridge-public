# Installation

RBridge is currently **Linux/systemd-first**. This document describes the supported shape of a production-style deployment; exact usernames, groups, paths and controller integration remain deployment choices.

## 1. Runtime requirements

Required for the base GitHub transport:

- Linux
- Node.js 22.x
- npm for build/install
- GitHub CLI at `/usr/bin/gh` or an equivalent deployment that matches the adapter
- a dedicated non-root runtime user
- GitHub credentials for that runtime user
- writable durable state directory
- a request/result GitHub repository

Optional/additional dependencies:

- `APP_RUN`: compatible controller broker
- FlowPilot ingress: controller broker plus FlowPilot callback/tokens
- built-in `node-safe` and `stdin-echo` process profiles currently expect the runtime Node binary path encoded in the source profile; inspect `src/domain/remoteBridgeHostProfiles.ts` on your release before enabling PROCESS.

## 2. Build an exact source revision

```bash
git clone https://github.com/zbaksa/rbridge-public.git
cd rbridge-public
git checkout <release-or-exact-sha>

npm ci --ignore-scripts
npm run verify
```

Do not deploy a dirty checkout as if it were the verified commit.

## 3. Create a dedicated runtime account

Example only — adapt account-management policy to your host:

```bash
sudo useradd --create-home --shell /bin/bash rbridge
```

RBridge itself verifies that:

- the process is not UID 0;
- the actual username equals `RBRIDGE_RUNTIME_USER`;
- the runtime home is an absolute non-root path.

## 4. Prepare a release directory

The shipped systemd template expects an immutable-style current-release layout:

```text
/usr/local/libexec/rbridge/releases/<sha>/
/usr/local/libexec/rbridge/current -> releases/<sha>
```

One possible staging pattern:

```bash
SHA="$(git rev-parse HEAD)"

sudo install -d -o root -g root -m 0755 \
  "/usr/local/libexec/rbridge/releases/$SHA"

sudo cp -a dist package.json \
  "/usr/local/libexec/rbridge/releases/$SHA/"

sudo ln -sfn \
  "/usr/local/libexec/rbridge/releases/$SHA" \
  /usr/local/libexec/rbridge/current
```

For stronger immutability, make release files root-owned and non-writable by the runtime account.

## 5. Prepare durable state

The default runtime derives state from the dedicated user's home:

```text
/home/rbridge/.local/state/rbridge
```

Prepare it with restrictive permissions:

```bash
sudo install -d -o rbridge -g rbridge -m 0700 \
  /home/rbridge/.local/state/rbridge
```

Subdirectories are created for request state, process sessions, transfers and optional FlowPilot bridge state.

## 6. Authenticate GitHub as the runtime user

The GitHub Issue adapter executes `gh` as the RBridge process user.

Authenticate that identity:

```bash
sudo -u rbridge -H gh auth login
sudo -u rbridge -H gh auth status
```

Use a GitHub identity with only the permissions needed for the configured control repository.

RBridge needs to list Issues, read Issue bodies/comments, add result comments and close completed Issues.

## 7. Runtime environment file

Create a root-owned environment file, for example `/etc/rbridge/runtime.env`:

```text
RBRIDGE_RUNTIME_USER=rbridge
RBRIDGE_RELEASE_SHA=<40-hex-git-sha>
RBRIDGE_GITHUB_REPOSITORY=owner/control-repository
RBRIDGE_GITHUB_AUTHOR=trusted-github-login
```

Protect it:

```bash
sudo chown root:root /etc/rbridge/runtime.env
sudo chmod 0600 /etc/rbridge/runtime.env
```

See [Configuration](CONFIGURATION.md) for optional FlowPilot values.

## 8. systemd

The repository ships `ops/systemd/rbridge.service.in` as a deployment template.

Render these placeholders:

- `@RBRIDGE_USER@`
- `@RBRIDGE_GROUP@`
- `@CONTROLLER_GROUP@`
- `@RBRIDGE_HOME@`
- `@RBRIDGE_ENV_FILE@`
- `@RBRIDGE_STATE_ROOT@`

The template currently uses the project's AI Tool Fabric Node runtime path in `ExecStart`. If your deployment does not provide that exact runtime, render/maintain a site-specific unit that invokes your verified Node 22 binary and the same `remoteBridgeMain.js` entry point.

Do not casually remove the hardening directives. The template includes:

- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=read-only`
- explicit `ReadWritePaths`
- `PrivateTmp=yes`
- `PrivateDevices=yes`
- empty capability bounding/ambient sets
- `UMask=0077`

After rendering:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rbridge.service
sudo systemctl status rbridge.service
```

## 9. Acceptance check

Use a HEALTH request from [Quick Start](QUICKSTART.md).

Verify:

- the service is active/running;
- result schema is `COCWIN_REMOTE_BRIDGE_RESULT_V2`;
- HEALTH status is PASS;
- the release SHA equals the deployed revision;
- the request Issue is closed only after result publication.

Then test only the capabilities you actually intend to expose.

## Upgrade rule

Treat source/CI acceptance and live deployment acceptance as separate gates:

1. build and test the exact candidate;
2. stage a new immutable release directory;
3. preserve durable state;
4. point `current` to the new release;
5. restart and run HEALTH/canaries;
6. roll back the pointer/service if acceptance fails.

See [Operations](OPERATIONS.md).
