# V1 bounded GitHub transport repair

This candidate is based on `dcf3cb9ad8b43532c19fff849eab086b280915d9`.
It changes GitHub transport and configuration only. It is not a durable-store
migration and does not incorporate the divergent development branch.

## What changes

- Intake uses the repository's author-filtered GraphQL issue connection, in
  pages of 100 metadata records. It does not fetch unrelated issue bodies.
- Exact request prefix and author are checked locally. Candidate bodies are
  fetched individually and their number, current author, title and OPEN state
  are checked again. Deleted/transferred candidates that are no longer found
  are skipped. A response from a different repository is rejected.
- Cursor pagination continues beyond 1,000 entries. It does not use GitHub
  search or buffer all pages through `gh --paginate`.
- Resuming a large result reads comment pages of 10. If a page exceeds the
  configured output cap, it is retried at the same cursor with a smaller page,
  down to one comment. A single item that still exceeds the cap fails explicitly.
- Partial API errors, malformed pagination and cursor cycles fail the operation.
  Publication still checks chunk collisions and closes the issue only after the
  chunks and final manifest have succeeded.
- Raw stdout/stderr bytes are counted separately before buffering and decoded
  once; UTF-8 characters split across child-process chunks remain intact.
- Command failures include the operation stage (`list-metadata`, `issue-body`,
  `resume-comments`, `publish-comment`, `close-issue`). The bridge does not log
  command stdin/stdout. Existing upstream CLI stderr diagnostics are still
  whitespace-normalized and limited to 256 characters; not all validation
  errors include a stage. Structured error classification/redaction remains a
  follow-up improvement, as does limiting page-shrink retries to stdout overflow
  instead of the existing output-error text marker.

## Runtime settings

| Environment variable | Default | Accepted range |
| --- | ---: | ---: |
| `RBRIDGE_GITHUB_MAX_OUTPUT_BYTES` | 16,777,216 bytes (16 MiB) | 1,048,576..33,554,432 bytes |
| `RBRIDGE_GITHUB_TIMEOUT_MS` | 30,000 ms | 1,000..120,000 ms |

Values are strict positive decimal integers. Whitespace, units, fractions,
exponents, non-finite values and out-of-range values fail startup before intake.
Omit a variable to use its default. Existing installations without these variables
receive the new 16 MiB per-stream output budget. A startup
`RBRIDGE_GITHUB_TRANSPORT_CONFIG_V1` record reports both effective limits after
the bridge acquires its process lock. No repository name, author or credential
is included in that configuration record.

The output limit applies to each command and separately to stdout/stderr. It is
not an unlimited aggregate-memory guarantee for the entire queue, a maximum
local file size, or a GitHub service quota override. Queue admission remains the
existing worker's responsibility. Both the overall API cost of a very large
backlog and existing first-20 worker behavior remain separate concerns.

## Limits intentionally unchanged

Request JSON size, APP_RUN arguments/time/output, allowed tools and paths,
FILE/PROCESS/CHUNK capabilities, result chunk size, durable identities and
replay/collision protections retain their existing contracts. Disk analysis can
run locally and return bounded reports once transport and host permissions are
verified. Larger local file/log and long-job features are separate changes.

## Qualification and activation

Source tests and CI do not prove that a running host was upgraded. Review the
exact candidate, run Node 22 verification and preserve the active release for
rollback. Activation requires an authorized host path, verified immutable files,
coordinated selected-release and release-SHA settings, and confirmation that
resumed intake is within the operator's permitted scope. This repair does not
authorize changing another service's policy or replaying old jobs.

After activation, a newly created, unexpired HEALTH request must report the
exact candidate release. Separately verify a bounded read of the intended
directories through the authorized capability. An old expired request or an
`active` service alone is not end-to-end acceptance evidence.

## References

- [GitHub CLI API](https://cli.github.com/manual/gh_api)
- [GitHub GraphQL issue connections and filters](https://docs.github.com/en/graphql/reference/issues)
- [GitHub API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
