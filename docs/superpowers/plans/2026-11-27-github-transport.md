# V1 GitHub Transport Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation and one independent final review.

**Goal:** Restore bounded GitHub intake/recovery and make the command output/time budgets configurable.

**Architecture:** Keep the current GhCommandRunner and worker interfaces. Fetch repository-bound cursor pages and candidate bodies through `gh api graphql`; keep mutation envelopes and durable behavior intact.

**Tech Stack:** TypeScript, Node 22, locked npm dependencies, Vitest, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-11-27-github-transport-design.md`

## Global Constraints

- Start at `dcf3cb9ad8b43532c19fff849eab086b280915d9`; no durable migration or unrelated branch changes.
- Preserve exact local author/prefix and identity checks; no new command capabilities.
- Output budget: default 16,777,216 bytes, range 1,048,576..33,554,432.
- Command timeout: default 30,000 ms, range 1,000..120,000.
- Issue metadata pages: 100; comment pages: 10 with byte-overflow halving down to 1.
- Report source, CI and live evidence separately.

## Review Focus

- An unrelated issue body must never fill the intake buffer.
- More than 1,000 issues and more than 2 MB of prior comments must remain discoverable.
- Closed/transferred/renamed or differently authored candidates must not execute.
- Partial GraphQL errors, null data or cursor cycles must not produce partial success.
- UTF-8 boundaries and separate stdout/stderr budgets must not corrupt valid replies.

### Task 1: Cursor-based transport and output budgets

**Files:** `src/adapters/githubIssueRemoteBridge.ts`, `tests/adapters/github-issue-remote-bridge.test.ts`, new focused runner test if needed.

**Interfaces:** Preserve `GhCommandRunner`, `listOpenRequests()` and `publishResult()`. Extend `GitHubIssueRemoteBridgeOptions` with optional `maxOutputBytes` and `timeoutMs`; export a shared validated transport-settings resolver for the runtime.

- [ ] Reproduce old aggregate-output failure using a bounded external-runner fixture; observe RED.
- [ ] Cover metadata-only intake, cursor continuation beyond 1,000 items, exact identity revalidation, stale state and malformed/error/cyclic replies.
- [ ] Implement the repository GraphQL page/body readers with no search or aggregate pagination.
- [ ] Cover interrupted publication with more than 2 MB of prior comments, cross-page collisions and page-size reduction; implement recovery.
- [ ] Cover strict limits and child raw-byte/UTF-8 behavior; implement bounded buffering and stage-specific errors.
- [ ] Run targeted tests, inspect results, and commit.

### Task 2: Runtime configuration and qualification

**Files:** `src/server/remoteBridgeMain.ts`, `tests/server/remote-bridge-main.test.ts`, focused runtime wiring test, `docs/GITHUB_TRANSPORT.md`.

**Interfaces:** Runtime consumes the adapter's validated transport settings and passes them to `createGitHubIssueRemoteBridge`; existing repository/author resolver remains compatible.

- [ ] Test environment parsing and real-main wiring before changing runtime; observe RED.
- [ ] Wire the two settings and log only resolved nonsecret transport budgets at startup.
- [ ] Document defaults, ranges, limits left unchanged, and separate source/activation status.
- [ ] Run targeted tests, full suite, typecheck, lint, server build, public scrub and `git diff --check`.
- [ ] Obtain independent whole-diff review, resolve material findings with regressions, publish exact candidate to the isolated review branch and inspect exact-commit CI.
- [ ] Report a concrete activation path or precise host-access blocker; never equate CI with a restored live bridge.
