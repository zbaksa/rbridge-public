# Read-only host facts implementation plan

> Execute inline with superpowers:executing-plans. Existing owner authorization covers read-only investigation; no additional design approval is requested.

**Goal:** Collect bounded service/process/code-file observations needed before a separately authorized installation.
**Architecture:** One standard-library Python CLI reads systemd metadata, the bridge process's selected environment keys, its root-owned HOLD file, and up to four owner-specified installed Python components. It emits observations only; installed bytes never establish loaded policy or production admission.
**Tech Stack:** Python 3, existing Node 22 CI, unittest.
**Spec:** Existing owner read-only runtime qualification requirements and this plan's constraints.

## Global Constraints

- No writes, child-code execution, service actions, network calls, repair or replay.
- Root identity, isolated Python and exact expected hostname required before host inspection.
- No complete environment, tokens, configuration contents or source contents in output.
- Fixed systemctl executable; bounded unit names, files, reads and subprocess timeouts.
- Component paths are canonical `.py` files below `/usr/local/libexec`; root-owned, non-writable ancestor chain and stable regular-file metadata required.
- Every successful collection remains `OBSERVED_ONLY`; production authorization and FENCE remain UNKNOWN.

## Review Focus

- Context rejection must precede all service/file observations.
- Symlinks, hardlinks, oversize and concurrent file changes must block.
- Only release/HOLD keys may leave the process environment reader.
- Component arguments must never select an executable or shell command.
- Service/process replacement during collection must prevent a stable observation claim.

## Task 1: Collector and executable negative regressions

Files: `ops/diagnostics/rbridge_host_facts.py`, `tests/ops/test_rbridge_host_facts.py`.
Interfaces: `check_context(host, uid, gid, isolated, no_site, no_bytecode)`; `read_regular(path, limit)` returns bytes and metadata; `selected_environment(raw)` returns selected values only; `parse_component(value)` returns name/path/SHA.

- [ ] Write and observe failing tests for context, components, stable reads, links, size, drift and environment disclosure.
- [ ] Implement bounded read-only collection and context checks.
- [ ] Run the Python suite and existing project checks.

## Task 2: Qualification and handoff

- [ ] Add the Python suite to the existing exact-HEAD workflow.
- [ ] Review the diff, record limitations, and publish a Draft source PR.
- [ ] Prepare one hash-bound owner command; host execution remains NOT_RUN until an allowed channel or owner returns actual evidence.

Ruling: No new server or transport is introduced. Existing operational access is blocked independently of source development; source tests cannot remove that blocker.

## Qualification record

- Initial missing implementation: eight regressions observed RED, then GREEN.
- Reserved HOLD label and option-like unit name: two further regressions observed RED, then GREEN.
- One independent source review found shortened hostname matching and ancestor substitution. Both failures were reproduced before the fixes; the collector now checks the full hostname and holds directory descriptors through final ancestry revalidation.
- Process/unit drift coverage was treated as required acceptance coverage and added with an actual process-UID rejection case. Final Python suite: 16 tests.
- Local Node suite: 231/239; eight PROCESS cases encounter the environment's forbidden Unix socket listener. Do not report that local suite as PASS. The canonical exact-HEAD runner must qualify the complete suite.
- Live host qualification, loaded/runtime policy correspondence, FENCE and production GO were outside the source review and remain UNKNOWN. The collector itself is NOT_RUN on the target host.
- CLI form: `python3 -I -S -B ops/diagnostics/rbridge_host_facts.py --host EXPECTED_FULL_HOSTNAME --runtime-uid UID --hold-sha SHA256 [--component NAME=/usr/local/libexec/example/module.py=SHA256] [--unit example.service]`. At most four components and four extra units. No argument selects an executable.
