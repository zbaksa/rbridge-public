# Owner browser readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. One fresh whole-component review before integration.

**Goal:** Observe the missing actual owner Native-history/profile metadata without modifying it.
**Architecture:** Extend the existing safe read-only collector. Reuse existing Windows CI and the actual RBridge1027 linked worktree; no new runtime route.
**Tech Stack:** PowerShell 5.1, existing Win32 held-ancestor reader and existing Windows/Local-First qualification.
**Spec:** docs/superpowers/specs/2026-10-27-owner-browser-readiness-design.md

## Global Constraints
- Canonical base95c21acccd2b5f4855eddb2ce0534d70a85eb742/tree61f2dd06cad047aa760f2cffed5b9488964d9242. Preserve full tree and untracked fixture.
- Actual app source/build/test identity1027; Windows ordinary-user evidence is CI, not the owner computer.
- Read-only, no event/database/private-key reads, no invented scope/pins/history, no SSH/browser send or production activation.

## Review Focus
- Concurrent Chrome writers must not turn a metadata snapshot into authenticated empty history.
- Junctions, drive remapping and ancestor replacement must not redirect directory enumeration.
- Foreign profile names/config fields and malformed paths must not leak secrets or trigger network IO.
- Root/profile enumeration and output must remain bounded even with hostile directory contents.
- Missing/busy/unrecognized data must remain distinguishable from observed empty metadata.

## Task 1: Bounded read-only observations
Files: scripts/collect-native-owner-facts-windows.ps1, scripts/test-native-owner-facts-windows.ps1, scripts/test-native-owner-standard-user-windows.ps1 and these two documents.
Interfaces: additive V1 `installation.nativeHistory` and `chromeProfiles` observational objects; existing collector API unchanged.
- [ ] Add actual filesystem fixture tests for the spec cases, retaining all existing cases; watch RED because browser/history observations are absent.
- [ ] Add bounded volume-GUID directory observation using held ancestors; report snapshot-only history and fixed-extension directory metadata.
- [ ] Exercise the collector in the existing ordinary-user Windows driver. Run facts GREEN, retained Windows suites and full exact-head Linux verification plus actual RBridge app type/lint/build/diff checks.
- [ ] One whole-component review and at most one regression-first Important correction pass; integrate exact qualified head with expected-head guard and verify anonymous pinned source delivery.
- [ ] Save truthful checkpoint/tracker and only the necessary owner action. Actual Windows profile/CHAT acceptance stays NOT_RUN until real evidence arrives.
