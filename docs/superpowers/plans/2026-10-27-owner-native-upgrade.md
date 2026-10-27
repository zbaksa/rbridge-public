# Qualified owner Native executable upgrade Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, then one fresh whole-component review. User opted out of questions and authorized source integration and operation.

**Goal:** Update the managed Windows Native executable while preserving its working SSH identity and all configuration/history.

**Architecture:** Fixed qualified artifact, existing first-install provenance and named mutex, one atomic executable replacement with bounded verification/rollback. Existing ordinary-user CI harness carries regression tests.

**Tech Stack:** Windows PowerShell5.1/.NET, existing GitHub/Remote Bridge and CI.

**Spec:** docs/superpowers/specs/2026-10-27-owner-native-upgrade-design.md

## Global Constraints

- Canonical parent11c67238e4d1998e0fab166da048c655b478a1d6/tree8c9bcbff05da322d1fed8401405e4ac272a82844; isolated linked actual RBridge1027 worktree; preserve untracked files.
- Existing qualified package/executable only, fixed extension id, no key/config/registration/history writes, no V3/AI activation.
- First-install receipt is historical and preserved; rerunning its old bootstrap after the upgrade is expected to reject the new executable.

## Review Focus

- Existing/unknown/V3 installation and invalid archive must fail before executable publication.
- Reparse, hardlink and concurrent ordinary-owner changes must not redirect the target or overwrite unrelated files.
- Locked executable or failed verification must preserve/restore exact old bytes or clearly return UNCERTAIN.
- A repeated successful update must work without archive/network and preserve key/history/ACL/registration.
- Diagnostics and staged cleanup must not disclose private key material or delete unknown paths.

### Task1: Fixed executable upgrade and ordinary-user regressions

Files: create scripts/upgrade-native-owner-windows.ps1 and scripts/test-native-owner-upgrade-cases-windows.ps1; extend scripts/test-native-owner-standard-user-windows.ps1 with optional UpgradePackageZip; wire the qualified new archive into .github/workflows/topplan-w1-windows-native-host.yml.

- [ ] Write ordinary-user cases against missing updater; use real old/new qualified archives and existing successful setup fixture.
- [ ] Observe Windows RED before implementing updater.
- [ ] Implement fixed archive validation, provenance/config/registration/key snapshots, read-only candidate check and atomic replacement/rollback; no generic execution or migration.
- [ ] Observe ordinary-user cases GREEN and exact-head full Windows/Linux CI; normal RBridge source checks and canonical blob hashes.
- [ ] One fresh whole-component review; one regression-first fix pass for accepted Important/Critical findings, no re-review.
- [ ] Integrate exact qualified source, save actual owner SSH PASS and prepare only the necessary pinned Windows update invocation. Actual owner update remains NOT_RUN until its real receipt.

Ruling: preserve the current default Native configuration and defer V3 provisioning to genuine profile/history authority. Choosing a pin from fixtures would create false readiness; the cost is a separate provisioning step.
