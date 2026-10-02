# SDD ledger — plan: docs/superpowers/plans/2026-09-30-cocwin-m0-v3-integration.md

# Task 8 fixed Linux peer continuation, 2026-10-02 R1

Base b189ec59f329ad97269f2c042f5f25d9a86e4a93 is the independently qualified dependency increment, stacked after Native b7be8600. Worktree /home/rbridge/backend/.cocwin-worktrees/m0-v3-fixed-peer-20261002-r2; canonical b796 and qualified Native/dependency donors preserved. Source, exact CI and live deployment are distinct gates.

Ruling: private peer spool configuration is loaded from the fixed private v3-peer-config.json child of the trusted established root; the root-only constructor matches the approved API. The installed CLI will obtain its root from fixed root-approved configuration, with no wire path/executable/host selection. Unit fixtures supply private app-owned configuration and a trusted pinned-channel HELLO; that is not live SSH authentication or installation evidence — cost if wrong: a missing owner install or invalid private root remains BLOCKED rather than gaining fallback access.

Ruling: each immutable upload descriptor binds commandId, commandSha256, requestDigest, full transfer SHA-256, totalBytes, chunkCount, exact index/3072-byte offset and canonical base64 <=4096 bytes. No chunk stage may enqueue. Only complete validated commit can reserve and enqueue; complete wire JSON must be canonical and within negotiated ceiling — cost if wrong: a refused upload requires explicit investigation rather than a truncated command reaching the browser.

Ruling: a dispatch is durably marked before framed output and is never blindly resent after uncertainty or restart. Original results and V1 event sequence remain retained across generations; a historical read requires the original command scope and grants no authority to the current generation — cost if wrong: unresolved effects remain uncertain and need read-only RECONCILE rather than risking another click.

Task8 store tests first:16 behavior cases (one Linux-specific mode probe). At this test-only source, implementation is absent and targeted RED is NOT_RUN. The plan's fixed entrypoint/CLI, stdio channel/liveness, C broker transport and installed forced-command gates remain OPEN; this ledger does not claim full Task8 completion.

Ruling: restart fixtures explicitly close the old trusted channel before reopening. A fresh peer object in the same process is not evidence that the old stream ended; an additional test rejects replacement of an existing live pinned channel and late input from its old owner — cost if wrong: concurrent channels could grant stale input current transport authority. Initial issue12894 watched16/16 expected failures after a successful build; updated test-only candidate adds the live-channel gate before implementation.
