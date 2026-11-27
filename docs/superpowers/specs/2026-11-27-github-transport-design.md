# V1 GitHub transport repair

## Intent and scope

Restore request intake and resumable result publication when unrelated issue bodies
or historical result comments exceed the old 2,000,000-byte command output cap.
The owner requested repair and useful configurable limits in the existing bridge.
This candidate starts at installed-source baseline `dcf3cb9ad8b43532c19fff849eab086b280915d9`.
It does not adopt the divergent development branch's durable-state migration.

## Approach

Increasing the old cap alone delays the same failure. Search-only filtering adds
search semantics and a result ceiling. Use the repository GraphQL connections
through the existing authenticated `gh` executable instead: author-filtered issue
metadata pages, then individually fetched candidate bodies, and cursor-paged
comments for publication recovery. Keep exact local author/prefix checks and
recheck issue number, current title, author and OPEN state after fetching a body.
Bind every response to the configured repository. Reject partial GraphQL errors,
invalid page metadata and repeated cursors instead of returning partial success.

Each command remains bounded. Metadata pages contain at most 100 issues;
comment pages start at 10 and shrink on an output-cap failure without advancing
the cursor. Single-object failures remain explicit. No search result cap or
aggregate `--paginate`/`--slurp` buffer is used.

Raise the default command output budget to 16 MiB and expose
`RBRIDGE_GITHUB_MAX_OUTPUT_BYTES` (1 MiB through 32 MiB) and
`RBRIDGE_GITHUB_TIMEOUT_MS` (1,000 through 120,000; default 30,000).
Parse strict decimal integers, fail before intake on invalid settings, and emit
resolved nonsecret transport settings at startup. Count raw stdout/stderr bytes
separately before buffering and decode once to preserve split UTF-8 sequences.
Command wrappers identify the operation stage; request/comment stdin and command
stdout are not logged. Existing bounded upstream CLI diagnostics remain, with
structured error classification/redaction explicitly deferred after review.

## Boundaries

No changes to request schemas, authorization, file/process/app capabilities,
durable records, request identities, result envelope format, chunk size or
publication collision checks. No dependency or service-hardening changes.
Existing workers still determine per-tick execution admission; this change does
not claim a new scheduler or eliminate existing queue starvation behavior.
Source/CI proof is separate from activation and host end-to-end proof.

## Acceptance

Regression fixtures reproduce the old oversized aggregate issue and comment
failures. New intake fetches only candidate bodies, sees candidates beyond the
old 1,000-item boundary, rejects wrong identities and stale closed issues, and
never returns partial results after pagination/API errors. Publication recovers
all existing chunks across pages, preserves collision detection, and closes only
after all chunks and manifest succeed. Config and process-output boundaries are
covered. Run targeted tests, full Node 22 suite, typecheck, lint, build, public
scrub and diff check. Independent review must precede completion claims.
