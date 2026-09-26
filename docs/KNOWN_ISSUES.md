# Known issues

## RB-001 — missing FILE target is not terminal

Observed against the frozen Stage2 bridge: `FILE STAT` on a nonexistent target
raised raw `ENOENT`; the worker did not map it to a terminal result and the
request remained queued until manually closed.  Status: `CONFIRMED`, fix not yet
implemented.  Required proof: failing regression test, minimal error mapping,
all RBridge tests, typecheck, lint, build, and live canary after deployment.
