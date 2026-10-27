# Windows owner setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline; one fresh whole-component review at the end.

**Goal:** Provide one qualified owner command that installs missing Native Host prerequisites and returns the actual generated public identity.
**Architecture:** Reuse the original C091 ZIP, existing installer and Windows CI. Publish only that previously qualified binary archive to a fixed public prerelease; deliver the new bootstrap with an immutable source/hash.
**Tech Stack:** PowerShell5.1, Windows OpenSSH, existing Node/TypeScript CI and GitHub Actions.
**Spec:** docs/superpowers/specs/2026-10-27-windows-owner-setup-design.md

## Global Constraints
- Base34871a7ece320f78344a4416d6ead4cbafde88c3/treebdaa29dedd3b5fd1cc801c4ca786068cb59fa487; preserve complete canonical tree and externally managed private app worktree.
- Source/tests/build run as RBridge1027 or actual dedicated CI only; no app code/tests as root.
- ZIP artifact12718921370/source34871a7/run40471720486,34356996B SHA9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350; native SHA630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95.
- Current-user only; protect dedicated keys, no private upload, new daemon, generic shell, guessed V3 authority/history, root/SSH policy or production activation change.
- No actual browser sends/SSH authentication; retain R6 STOP and the prior denied duplicate action without replay.

## Review Focus
- Changed archive/entries cannot run a package script or alter destination/registry: tamper-before-write fixture.
- First install and rerun cannot overwrite an existing/partial/changed identity/config/V3 state: immutable rerun/changed-state fixtures.
- Busy installer and observed reparse/foreign destinations must preserve preimages: held mutex/reparse fixtures.
- Reports must contain public material only; real OpenSSH key generation and current-user ACL verified in the fresh fixture.
- Public publisher must only expose the already qualified six-file archive with exact SHA, successful source run and fixed target/tag; conflict means stop without clobber.

## Task1: Bootstrap, tests and durable qualified package
Files: create scripts/setup-native-owner-windows.ps1 and scripts/test-native-owner-setup-windows.ps1; modify .github/workflows/topplan-w1-windows-native-host.yml; same spec/plan. Existing installer stays unchanged.
Interfaces: consumes exact qualified ZIP and validated caller public host key; produces COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1 with real public identity and explicit NOT_RUN live gates. CI consumes `-PackageZip <original archive>`; publisher consumes successful Windows qualification and publishes original ZIP without rebuilding it.
- [ ] Write eight-case real Windows harness; insert bounded read-only artifact download/verification and harness step in existing Windows CI. Publish tests first; expected RED OWNER_SETUP_IMPLEMENTATION_ABSENT.
- [ ] Implement validated package staging, same installer mutex, dedicated key/ACL/known-host preparation, unchanged installer invocation, readback/receipt and no-write consistent rerun. Fresh returns INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT; rerun returns ALREADY_INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT.
- [ ] GREEN all eight Windows cases plus existing facts/native suites/11installer tests; actual1027 type/lint/build/diff and full exact-head Linux/Windows CI.
- [ ] Add narrow immutable archive publication job gated on Windows success, content-write only there; inspect created public release/download bytes separately from source/CI claims.
- [ ] One fresh whole-component review; Critical/Important one RED/GREEN fix pass with suite; Minor ledger. Qualified-head integration with expected-head lease, exact readback and tracker19281.
- [ ] Save owner facts and live server host-key proof privately; supply only the unavoidable owner Windows invocation after all available qualification. Real owner install/auth/V3/CHAT remain NOT_RUN until actual subsequent receipts.
