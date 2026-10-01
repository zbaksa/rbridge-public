# M0 V3 Native result-store foundation — 2026-10-01 R1

This increment implements only the Native result-storage component of Task 8. The complete fixed-peer transport, authenticated HELLO, broker chunk staging/commit, Native protocol/runtime forwarding and installed acceptance remain outstanding. It does not increase the number of completed M0 tasks. The production source and runtime were not promoted.

## Source and evidence

Base: `6ded881a64c56bc8ec8e001e547eb1125253b9ad`, the qualified Task 7 source. Candidate branch: `topplan/m0-v3-native-results-20261001-r1`.

| Checkpoint | SHA | Observation |
| --- | --- | --- |
| Initial test-first candidate | `a984051a98045e6afa0b8ea603f30d138bfc44bd` | Existing baseline 160 PASS; new suite 18 expected failures because implementation was absent |
| Initial implementation | `5a7629a84684364bb0f6cfad169378cb7a843c9a` | New suite 18 PASS; full verify 178 PASS |
| Independent-review regressions | `05e68b4eaf6c2d586e9bbe90615d184afa9790af` | Compilation succeeded; suite 22 PASS / 8 expected FAIL, reproducing all four Important findings |
| Combined review fixes | `528aabad682dec8a5b72a188433d1744a7d38679` | Suite 30 PASS / 0 FAIL / 0 SKIP on Linux; full verify 190 PASS |

All execution observations above came from bounded COCWIN Remote Bridge app jobs running as UID/GID 1027 on the app host, Node v22.23.2, in the isolated Native-results worktree. The review was source-only; the reviewer did not independently certify those execution receipts. Tests establish the exercised source behavior, not installed acceptance.

Review RED log SHA256: `9170b5812cc76751f628c41c1ebc067e540b6645eda8125cb0499488f81399a7`.
Review GREEN targeted log SHA256: `7c656d35c5c54a9d1eac268ef9d9f5c7d58596981eb185bcc6f6fd493fa2235d`.
Review GREEN full verify log SHA256: `fb0a0539da5e29b0b02c43607631a1437bebc9572c8baf18eb98885b0783c3a5`.

Full verify includes typecheck, the complete existing test sequence, lint, server compilation, extension artifact verification and Native bundle verification. Public scrub and diff whitespace checks passed for the review-fix candidate. The unwired module does not change the installed Native bundle behavior. Dependencies retain the earlier audit findings; this work does not claim an audit-clean dependency tree.

## Contract

`RbridgeEffectResultStoreV3` admits an immutable validated command through `reserve`, stores its complete correlated validated outcome through `record`, and exposes scoped copies through `read`. `replay` retains previously recorded generations for later transport journaling; that historical evidence grants no current-session authority. Results without a reservation, changed same-ID commands/results, forged digests, cross-app ownership changes and invalid current scopes are rejected.

Only the fixed `eventStoreRoot/v3-results` child is selected. `eventStoreRoot` must already be an established, private, app-owned real directory. Its durable creation is an integration prerequisite; this component never creates ancestor directories or silently repairs their permissions. POSIX containing-directory synchronization happens before admission, including retries after an uncertain first attempt. Child journal writes synchronize the file, rename atomically, synchronize the child directory and reread authoritative bytes before returning.

On POSIX, fixed authority/journal files open without following symlinks and with nonblocking mode before descriptor validation. Nonregular files, extra hardlinks, unsafe modes/ownership, malformed UTF-8, noncanonical JSON, missing/corrupt anchors and changed journal bytes fail closed. Same-process instances share a queue; an exclusive file lock blocks competing writers. Crash leftovers require explicit reconciliation and are not automatically removed.

Admission charges the command journal plus the full negotiated result ceiling for every unresolved entry, allowing maximum revision digit growth. A store that cannot retain those bounded results denies a new reservation before dispatch. Limits must remain unchanged for this guarantee; legacy state, reduced ceilings and retention/compaction require a separate integration contract. Disk free space or hardware durability is not guaranteed by this logical cap.

## Independent review and rulings

| Finding | Resolution | Regression and limit |
| --- | --- | --- |
| Important: missing parent-directory durability barrier | Require preexisting parent, synchronize containing directory before admission | Real handle instrumentation observes parent synchronization; injected synchronization failure prevents success. No actual power-loss campaign was run |
| Important: no reserved result capacity | Reserve full wire ceiling for every unresolved result | A 4096-byte journal cannot admit a command without result space; a larger bounded journal accepts two commands, rejects a third before dispatch, then stores both admitted outcomes |
| Important: FIFO open can hang while holding writer lock | POSIX nonblocking open, then regular-file descriptor validation | Separate bounded child processes reject authority and journal FIFOs; both previously timed out |
| Important: constructor scope vocabulary differs from protocol | Shared `parseV3Scope` used by request validation and store | Dotted and 96-character app IDs accepted; leading punctuation and excessive length rejected |
| Minor: readback coverage overstated | Add real-handle readback/write/rename/file-sync fault injection and instance fault assertions | Removing the readback barrier would fail the readback fault case; the journal symlink test is named accurately |

Sequencing ruling: finish the isolated storage foundation before opening a transport path. The cost is additional integration work and possible interface adjustment. Keeping it unwired avoids admitting production work through an unfinished endpoint. No Critical finding was reported, but that is not a proof of absence of defects. All four reported Important findings were addressed in one combined pass and verified; no second review certification is claimed.

Deferred/declined operational judgments: Windows ACL and directory durability; actual power-loss recovery; real competing/crashed writer processes; lock replacement/cleanup faults; capacity performance; retention and compaction; coordinated external rollback; historical configuration migration; late results after scope changes; peer authentication/ownership migration; full V1 event replay preservation; transport ordering and runtime persist-before-forward; cancellation/deadlines/reconciliation; endpoint installation and live browser capture.

The existing journal symlink case does not test a child-directory symlink. The root validation has that source check, but no additional coverage is claimed. Windows skips eight POSIX-specific probes explicitly; portable tests do not establish Linux-specific filesystem guarantees on Windows.

## Next boundary

Continue Task 8 from this exact candidate: strict fixed peer spool and chunk/commit-only enqueue; pinned HELLO/profile/release; Native union/runtime wiring that persists before forwarding and preserves original V1 events. Then Task 9 bounded EXECUTE/RECONCILE waits and original-attempt late-result handling, followed by Task 10 isolated opt-in integration. Positive original Markdown acquisition and installed/live acceptance remain separate blockers. Do not substitute a general shell or arbitrary app job for the required fixed endpoint.
