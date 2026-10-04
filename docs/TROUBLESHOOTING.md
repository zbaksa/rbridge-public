# Troubleshooting

RBridge intentionally returns specific error codes instead of silently broadening behavior.

## Service does not start

### `REMOTE_BRIDGE_RUNTIME_USER_CONFIG_INVALID`

`RBRIDGE_RUNTIME_USER` is missing or malformed.

### `REMOTE_BRIDGE_RUNTIME_USER_REQUIRED`

The actual OS user does not match `RBRIDGE_RUNTIME_USER`, or the service is running as root.

Fix the systemd `User=` and environment configuration rather than weakening the check.

### `REMOTE_BRIDGE_HOME_INVALID`

The runtime account has an unsafe/invalid home directory.

## GitHub transport errors

### `REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID`

Set:

```text
RBRIDGE_GITHUB_REPOSITORY=owner/repository
```

### `REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID`

Set the exact trusted GitHub login.

### `REMOTE_BRIDGE_GITHUB_COMMAND_FAILED`

Check GitHub CLI under the runtime user:

```bash
sudo -u rbridge -H gh auth status
sudo -u rbridge -H gh issue list --repo owner/control-repo
```

Also check network connectivity and GitHub rate limits.

## Request is immediately BLOCKED

Common V2 parser reasons:

### `REMOTE_BRIDGE_V2_AUTHOR_INVALID`

The Issue author does not equal the configured trusted login.

### `REMOTE_BRIDGE_V2_REPOSITORY_INVALID`

Request repository does not match configuration.

### `REMOTE_BRIDGE_V2_TITLE_INVALID`

Title must start with the exact request prefix defined in the current [Protocol reference](PROTOCOL.md).

### `REMOTE_BRIDGE_V2_TITLE_REQUEST_ID_MISMATCH`

The title suffix and JSON `requestId` differ.

### `REMOTE_BRIDGE_V2_BODY_JSON_INVALID`

Issue body is not valid JSON.

### `REMOTE_BRIDGE_V2_FIELDS_INVALID`

V2 uses exact fields. Remove unknown top-level properties.

### `REMOTE_BRIDGE_V2_REQUEST_EXPIRED`

Create a new request with a new requestId and fresh timestamps.

### `REMOTE_BRIDGE_V2_TTL_INVALID`

TTL must be at most 30 minutes.

### `REQUEST_ID_COLLISION`

The same requestId was already used with different request content.

Do **not** delete durable history to bypass this. Use a new requestId.

## FILE errors

### `REMOTE_BRIDGE_FILE_ROOT_DENIED`

Target is outside the source-controlled allowed roots. Current default public root is `/mnt/data`.

### `REMOTE_BRIDGE_FILE_SECRET_PATH`

The path looks like a protected secret-bearing path/name.

Move the intended non-secret file to an allowed safe path; do not bypass the check.

### `REMOTE_BRIDGE_FILE_SYMLINK_DENIED`

A symlink appeared in the path.

RBridge intentionally does not follow it. Use a real path inside the allowed root.

### `REMOTE_BRIDGE_FILE_TOO_LARGE`

The operation exceeds the configured read/write limit.

Use CHUNK for larger binary movement when appropriate.

### `REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK`

Text READ detected binary content. Use `READ_BINARY` or CHUNK.

### `REMOTE_BRIDGE_FILE_REPLACEMENT_COUNT_MISMATCH`

`EDIT_EXACT` did not find exactly the requested number of old-text occurrences.

Re-read the file and submit a new exact edit.

### `REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND`

A read-only operation targeted a missing path. This is terminal and replay-safe; see `docs/KNOWN_ISSUES.md` for the historical bug that was fixed.

## PROCESS errors

### `REMOTE_BRIDGE_PROCESS_PROFILE_NOT_ALLOWED`

The requested profile ID is not in source-controlled policy.

### `REMOTE_BRIDGE_PROCESS_ARGS_NOT_ALLOWED`

Profile exists, but argv is outside its fixed allowed shape.

### `REMOTE_BRIDGE_V2_PROCESS_EXECUTABLE_REQUEST_CONTROLLED`

A START request tried to supply `executable` or `executablePath`. This is intentionally forbidden.

### `REMOTE_BRIDGE_PROCESS_CWD_INVALID`

cwd is outside the profile's allowed roots or otherwise unsafe.

### `REMOTE_BRIDGE_PROCESS_START_UNCERTAIN`

RBridge cannot prove whether launch occurred.

Do not blindly retry with a new request. Inspect durable state first.

### `REMOTE_BRIDGE_PROCESS_ACTION_UNCERTAIN`

A follow-up action may have reached the supervisor but acknowledgement certainty was lost.

Treat as an uncertainty event, not a normal failure.

## CHUNK errors

### `REMOTE_BRIDGE_CHUNK_DIGEST_MISMATCH`

Decoded chunk bytes do not match the supplied SHA-256.

### `REMOTE_BRIDGE_CHUNK_COLLISION`

The transfer ID/index is being reused with conflicting immutable data.

### `REMOTE_BRIDGE_CHUNK_INCOMPLETE`

FINALIZE was attempted before every chunk was stored.

### `REMOTE_BRIDGE_CHUNK_FINAL_DIGEST_MISMATCH`

All chunks were present, but reconstructed object SHA-256 did not match.

### `REMOTE_BRIDGE_CHUNK_EXPIRED`

Create a fresh transfer ID and expiry; do not mutate the old manifest.

## Windmill orchestration

### Windmill created an Issue but RBridge does not process it

Check:

1. the Issue is in `RBRIDGE_GITHUB_REPOSITORY`;
2. the Issue author exactly equals `RBRIDGE_GITHUB_AUTHOR`;
3. the title uses the exact request prefix documented in [Protocol reference](PROTOCOL.md);
4. timestamps are fresh and TTL <= 30 minutes;
5. RBridge runtime GitHub credentials can list/read the Issue.

### Windmill cannot create/read Issues

Verify the GitHub token/resource used by Windmill has the permissions required for the control repository. Keep the token in Windmill secret storage, not directly in flow source.

### Windmill flow retried and may have created duplicate request Issues

Do not generate a new semantic request under the same requestId with different content. RBridge will report a collision.

Prefer a flow design where the create-request step runs once, returns the Issue number/requestId, and later retryable steps only poll the existing Issue/result.

### Windmill waits forever

Set a bounded polling timeout that is shorter than the RBridge request expiry. If the RBridge result is `UNKNOWN`, treat it as an uncertainty event rather than automatically creating a replacement side effect.

See [Windmill integration](WINDMILL.md).

## Result status is UNKNOWN

UNKNOWN is deliberate.

It means RBridge cannot safely prove a terminal success/failure, commonly because an external execution acknowledgement or process identity became uncertain.

Recommended response:

1. preserve state;
2. inspect the original request/session/operation;
3. query status when possible;
4. avoid duplicate side effects;
5. resolve the underlying transport/supervisor issue before resubmitting.

## Public CI fails the scrub

The CI scan rejects private/internal leakage patterns in public source/docs.

Do not work around it with encoding or obfuscation. Replace private deployment values with configuration placeholders and examples suitable for a public repository.
