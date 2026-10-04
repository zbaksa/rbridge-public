# Quick Start

This guide gets a local Linux checkout from clone to one successful **HEALTH** request over the GitHub Issue transport.

> Compatibility note: some exact wire literals in the copy/paste examples retain a legacy namespace. Treat those strings as opaque protocol constants for the current revision; they do not name a required public dependency.

It deliberately starts with HEALTH because it exercises authentication, request parsing, durable state, result publication and Issue closure without granting file or process access.

## Prerequisites

- Linux
- Node.js 22.x
- npm
- Git
- GitHub CLI (`gh`)
- a GitHub repository you control for requests/results
- a non-root local user

Check the basics:

```bash
node --version
npm --version
gh --version
gh auth status
```

## 1. Clone, install and verify

```bash
git clone https://github.com/zbaksa/rbridge-public.git
cd rbridge-public
npm ci --ignore-scripts
npm run verify
```

`npm run verify` runs the full test suite, typecheck, lint and server build.

## 2. Choose the control repository

RBridge does not accept requests from arbitrary GitHub repositories or users.

Set both values explicitly:

```bash
export RBRIDGE_GITHUB_REPOSITORY="YOUR_LOGIN/YOUR_CONTROL_REPO"
export RBRIDGE_GITHUB_AUTHOR="YOUR_LOGIN"
```

The author must be the exact GitHub login that creates the request Issue.

## 3. Configure the runtime identity

RBridge refuses to run as root and requires the configured runtime user to match the actual OS user.

```bash
export RBRIDGE_RUNTIME_USER="$(id -un)"
export RBRIDGE_RELEASE_SHA="$(git rev-parse HEAD)"
```

The durable state root is derived from the runtime user's home:

```text
~/.local/state/rbridge
```

## 4. Start RBridge

```bash
node dist/server/server/remoteBridgeMain.js
```

Leave that terminal running.

RBridge polls the configured repository on a bounded loop. Successful ticks are logged as structured JSON.

## 5. Create a HEALTH request

V2 requests use:

- an Issue title of exactly `[COCWIN BRIDGE REQUEST] <requestId>`;
- an exact JSON schema;
- canonical ISO-8601 UTC timestamps;
- a maximum TTL of 30 minutes.

Generate a fresh body with Python:

```bash
REQUEST_ID="demo.health.$(date -u +%Y%m%d%H%M%S)"

BODY="$(
python3 - "$REQUEST_ID" <<'PY'
from datetime import datetime, timedelta, timezone
import json
import sys

request_id=sys.argv[1]
created=datetime.now(timezone.utc)
expires=created+timedelta(minutes=10)

def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00","Z")

print(json.dumps({
    "schema":"COCWIN_REMOTE_BRIDGE_REQUEST_V2",
    "requestId":request_id,
    "createdAt":iso(created),
    "expiresAt":iso(expires),
    "operation":{
        "kind":"HEALTH",
        "action":"STATUS"
    }
},separators=(",",":")))
PY
)"

gh issue create \
  --repo "$RBRIDGE_GITHUB_REPOSITORY" \
  --title "[COCWIN BRIDGE REQUEST] $REQUEST_ID" \
  --body "$BODY"
```

## 6. Read the result

RBridge will:

1. discover the open Issue;
2. verify repository, author, title and request schema;
3. claim the request durably;
4. execute the HEALTH operation;
5. publish a JSON result as an Issue comment;
6. close the Issue as completed.

A successful V2 result uses the exact result schema defined by the current protocol revision and includes a HEALTH payload with safe fields such as release SHA, uptime, queue count, active process sessions, active chunk transfers and last GitHub poll time.

## 7. Try a bounded file read

The current source-controlled FILE root is `/mnt/data`.

Create a harmless file:

```bash
mkdir -p /mnt/data
printf 'hello from RBridge\n' > /mnt/data/rbridge-demo.txt
```

Then send a fresh V2 request whose operation is:

```json
{
  "kind": "FILE",
  "action": "READ",
  "target": "/mnt/data/rbridge-demo.txt",
  "args": {}
}
```

Use a new requestId and fresh timestamps.

## What to try next

- [Protocol reference](PROTOCOL.md) for FILE, PROCESS, CHUNK, HEALTH and APP_RUN.
- [Installation](INSTALLATION.md) to turn the foreground process into a system service.
- [Security model](SECURITY_MODEL.md) before enabling write/process capabilities.
- [Troubleshooting](TROUBLESHOOTING.md) if a request is BLOCKED or remains pending.
