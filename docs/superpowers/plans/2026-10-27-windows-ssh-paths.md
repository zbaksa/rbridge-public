# Windows SSH launch paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. One fresh whole-component review at the end.

**Goal:** Remove the real Windows path blocker from the existing Native SSH launcher.
**Architecture:** Platform-specific lexical validation in the existing builder; unchanged shell:false argument transport and fixed remote command.
**Tech Stack:** TypeScript6, Node22, Windows OpenSSH, existing Windows/Linux CI.
**Spec:** docs/superpowers/specs/2026-10-27-windows-ssh-paths-design.md

## Global Constraints
- Canonical base8d27ec3a663973a229b3112c6dbeaa2a1741cbfe/tree06af79db06e4d561f07113ea7275f4967eb35d9d. Actual app work1027/1027; Windows-specific CI may use the required hosted OS. Preserve existing linked detached worktree/WIP and full canonical tree.
- No SSH/server policy change, private key transfer, arbitrary shell, fabricated peer/history or browser send. Server key enrollment is already complete in separate C094 evidence.
- Old owner executable630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95 remains installed until explicit qualified update. Source PASS cannot be called an owner Native fix.

## Review Focus
- Windows drive-relative/rooted/UNC/device/ADS inputs remain rejected in all three path fields.
- Paths with spaces remain single literal argv items and do not select a shell.
- Actual Windows OpenSSH executable path is consumable; platform fixtures are not owner SSH evidence.
- Linux path/host/user/port/fixed-command behavior remains unchanged.
- Existing Native config/private key/history and qualified owner receipt are never overwritten by source qualification.

## Task1: Existing launcher path boundary
Files: src/transport/sshStdio.ts; tests/w1-ssh-platform-paths.ts; package.json; .github/workflows/topplan-w1-windows-native-host.yml; this plan/spec.
Consumes: buildSshStdioLaunch(SshStdioLaunchConfig):SshStdioLaunch. Produces: same signature, valid native Windows paths preserved.
- [ ] Add literal expected argv/negative matrices/real Windows ssh version regression; wire into normal tests and early Windows workflow. Run unchanged production on Windows; Expected: FAIL RBRIDGE_SSH_PATH_INVALID for actual drive-absolute input.
- [ ] Small platform-specific validator repair; Expected: new tests and existing portable suites PASS on actual RBridge1027 and Windows.
- [ ] One fresh review, one regression-first fix pass if needed, exact-head full npm verify/type/lint/build/diff and canonical Windows CI. Preserve final artifact metadata, but do not relabel it published/installed.
- [ ] Leased source integration, exact readback, durable tracker/checkpoint; genuine Windows authentication and V3 provisioning remain independently gated.
