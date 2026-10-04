# Protocol reference

This document describes the public GitHub Issue **V2** request contract implemented by `src/domain/remoteBridgeStage2Protocol.ts`.

The wire names retain `COCWIN_...` prefixes for backward compatibility with the project's original deployment lineage.

## Request transport

A request is an open GitHub Issue in the configured control repository.

### Title

Exact format:

```text
[COCWIN BRIDGE REQUEST] <requestId>
```

The suffix must exactly match the JSON body's `requestId`.

### Author/repository

Both must match deployment configuration:

- `RBRIDGE_GITHUB_REPOSITORY`
- `RBRIDGE_GITHUB_AUTHOR`

### Body

Top-level schema:

```json
{
  "schema": "COCWIN_REMOTE_BRIDGE_REQUEST_V2",
  "requestId": "example.request.1",
  "createdAt": "2026-10-04T12:00:00.000Z",
  "expiresAt": "2026-10-04T12:10:00.000Z",
  "operation": {}
}
```

Constraints:

- body <= 65,536 bytes;
- `requestId` matches `^[a-z0-9][a-z0-9._:-]{0,127}$`;
- timestamps must be canonical ISO strings;
- expiry must be later than creation;
- TTL <= 30 minutes;
- creation may not be more than 2 minutes in the future;
- expired requests are rejected;
- unknown top-level fields are rejected.

## Operation kinds

V2 supports:

```text
APP_RUN
FILE
PROCESS
CHUNK
HEALTH
```

## HEALTH

Request:

```json
{
  "kind": "HEALTH",
  "action": "STATUS"
}
```

No other fields are accepted.

A successful snapshot contains safe operational fields:

- releaseSha
- uptimeMs
- queueCount
- sessionCount
- transferCount
- lastGitHubPollAt

## FILE

Shape:

```json
{
  "kind": "FILE",
  "action": "READ",
  "target": "/mnt/data/example.txt",
  "args": {}
}
```

Actions:

- `LIST`
- `STAT`
- `READ`
- `READ_MANY`
- `READ_BINARY`
- `WRITE_TEXT`
- `WRITE_BINARY`
- `APPEND_TEXT`
- `EDIT_EXACT`
- `MOVE`
- `SEARCH`

The request cannot override allowed roots.

### LIST

Optional:

```json
{"maxEntries": 100}
```

Range: 1-500, default 500.

### READ

```json
{}
```

Returns UTF-8 text. Binary content requires `READ_BINARY`.

### READ_MANY

Target is a directory:

```json
{
  "paths": ["a.txt", "subdir/b.txt"]
}
```

1-32 relative safe paths.

### READ_BINARY

```json
{}
```

Returns base64, byte count and SHA-256.

### WRITE_TEXT

```json
{"text":"hello\n"}
```

### WRITE_BINARY

```json
{
  "dataBase64": "aGVsbG8=",
  "sha256": "<sha256-of-decoded-bytes>"
}
```

### APPEND_TEXT

```json
{"text":"next line\n"}
```

The current implementation may create the target when it does not yet exist.

### EDIT_EXACT

```json
{
  "oldText": "before",
  "newText": "after",
  "expectedReplacements": 1
}
```

The edit fails if the actual replacement count differs.

### MOVE

```json
{
  "destination": "/mnt/data/new-name.txt"
}
```

Cross-root moves are rejected.

### SEARCH

Target is a directory:

```json
{"query":"needle"}
```

Search is bounded by scan depth/count/size limits.

## PROCESS

Actions:

- `START`
- `STATUS`
- `READ_OUTPUT`
- `WRITE_INPUT`
- `TERMINATE`

### START

The request selects a source-controlled profile, not an executable path:

```json
{
  "kind": "PROCESS",
  "action": "START",
  "args": {
    "profileId": "node-safe",
    "cwd": "/mnt/data",
    "argv": ["--version"],
    "lifetimeMs": 30000
  }
}
```

A request containing `executable` or `executablePath` is rejected.

Current public profile IDs:

- `git-read`
- `node-safe`
- `stdin-echo`

The returned session record includes the session identity needed for follow-up operations.

### STATUS

```json
{
  "kind": "PROCESS",
  "action": "STATUS",
  "sessionId": "<session-id>",
  "args": {
    "ownerDigest": "<digest-returned/associated-with-session>"
  }
}
```

### READ_OUTPUT

```json
{
  "kind": "PROCESS",
  "action": "READ_OUTPUT",
  "sessionId": "<session-id>",
  "args": {
    "ownerDigest": "<digest>",
    "cursor": 0,
    "maxBytes": 65536
  }
}
```

Output is cursor-based and chunk records identify stdout/stderr. `dataBase64` prevents encoding ambiguity.

### WRITE_INPUT

Only profiles with UTF-8 stdin enabled accept input:

```json
{
  "kind": "PROCESS",
  "action": "WRITE_INPUT",
  "sessionId": "<session-id>",
  "args": {
    "ownerDigest": "<digest>",
    "data": "hello\n"
  }
}
```

### TERMINATE

```json
{
  "kind": "PROCESS",
  "action": "TERMINATE",
  "sessionId": "<session-id>",
  "args": {
    "ownerDigest": "<digest>"
  }
}
```

## CHUNK

Actions:

- `PUT`
- `GET`
- `FINALIZE`

Chunk transport is for bounded binary/object transfer with digest validation.

A PUT carries:

- transferId;
- index;
- count;
- base64 data;
- chunk SHA-256;
- object SHA-256;
- expiration.

The store rejects conflicting replays, missing/corrupt chunks, expired transfers and final digest mismatch.

See `src/server/remoteBridgeChunkStore.ts` for exact fields and limits on your release.

## APP_RUN

Shape:

```json
{
  "kind": "APP_RUN",
  "appId": "example",
  "jobId": "job-1",
  "payload": {
    "tool": "probe",
    "cwd": "/absolute/path",
    "args": [],
    "timeout_ms": 30000,
    "max_bytes": 32768
  }
}
```

Allowed payload tools:

- `node`
- `npm`
- `git`
- `opencode`
- `verify`
- `probe`

Bounds include:

- timeout 1,000-1,800,000 ms;
- output 4,096-1,048,576 bytes;
- bounded argument count/size;
- canonical absolute cwd.

APP_RUN requires the compatible controller broker.

## Results

V2 result schema:

```text
COCWIN_REMOTE_BRIDGE_RESULT_V2
```

A result includes:

- requestId;
- Issue number;
- status;
- request SHA-256;
- result SHA-256;
- operationResult;
- completedAt;
- optional reason.

Status may be:

- `PASS`
- `FAIL`
- `BLOCKED`
- `UNKNOWN`

### Why UNKNOWN exists

If RBridge cannot safely determine whether a side effect already happened, it avoids a blind retry and surfaces uncertainty instead.

## Replay and collisions

A `requestId` is a durable identity.

- Same requestId + same canonical digest: replay-safe.
- Same requestId + different request: `REQUEST_ID_COLLISION`.

Never intentionally reuse a requestId for different work.

## Publication

Small results are published as one fenced JSON Issue comment.

Large results are split into:

- `COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1`
- `COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1`

with SHA-256 integrity and publication replay protection.

After successful result publication, the GitHub Issue is closed as completed.
