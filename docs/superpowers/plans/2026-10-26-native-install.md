# Native V3 Installation Implementation Plan

> For agentic workers: use superpowers:executing-plans inline. One whole-branch review at the end.

**Goal:** Install supplied V3 configuration without silently downgrading an existing V3 Native host.

**Architecture:** The existing Native parser validates exact staged bytes through a read-only CLI mode; PowerShell imports or preserves them before any installer mutation.

**Tech Stack:** Existing TypeScript/Node22, PowerShell and Windows SEA; existing Bridge and CI only.

**Spec:** docs/superpowers/specs/2026-10-26-native-install-design.md

## Global Constraints

- Canonical parent6daf6c03f16219c7edc46a6f1f3b482abf801d57/tree dc00b29f1a1b5792c0df4f31c24f3d8c9d9486fb. Local source is a partial mirror; publish only intended files over the full base.
- No new transport/controller/SSH service, credentials, generated peer pins, history reset, root-worker changes or production activation.
- Read-only check must never open SSH or initialize stores. Preserve released Chrome minor0 entry and unavailable legacy capture.

## Review Focus

- Existing V3 config/history must survive default reinstall exactly.
- Explicit changed scope/pins/history or event root must not overwrite existing V3 ownership.
- Invalid/mutated/staged config and bad checker output must fail before install or registry mutation.
- Checker mode must not accept normal wire traffic or start a process/channel.
- Existing V1 Native invocation, installer and builds must remain compatible.

## Task1: Native check and immutable V3 installation

Files: modify src/nativeHost/nativeHostConfig.ts, nativeHostCli.ts, scripts/install-native-host-windows.ps1, package.json and Windows Native workflow; create tests/w1-v3-native-install.ts and scripts/test-native-v3-install-windows.ps1.

Consumes existing loadNativeHostConfigV1/parseNativeHostConfigV1 and private Native V3 types. Produces loadNativeHostConfigDocumentV1(path): {config,sourceSha256}; CLI --check-config receipt; optional -V3ConfigFile installer parameter with no V3 rewrite.

- [x] Write child-process CLI checks for exact config-byte hash, valid V1/V3, invalid scope/pins/history/path/extra args, unchanged roots and no SSH sentinel.
- [x] Run TypeScript build and expected CLI RED through normal1027 Bridge. Run Windows baseline PreserveExisting case expecting QA085_EXISTING_V3_WAS_REMOVED, not an arbitrary failure.
- [x] Implement minimal same-snapshot Native config receipt/CLI and installer import/preservation only after their RED evidence.
- [ ] GREEN CLI, existing Native suites, TypeScript/lint/diff under1027; actual Windows SEA All installer cases including invalid-before-write, new V3, unchanged reinstall/history, changed rejection and V1 compatibility.
- [ ] One fresh whole-branch review; one RED to GREEN fix pass for Important findings.
- [ ] Exact candidate full Linux/Windows CI and qualified-head integration; persist receipts and unqualified live gates.

## Ledger

Ruling: complete caller-provisioned config only; no new pin generator or production entry switch — shortest path that respects existing authority — live profile still requires its separate provisioning/acceptance.

Pre-flight: one task shares the loader snapshot digest with CLI receipt and installer verification. The digest always names parsed bytes, never an independent reread.

- #20795: normal1027 baseline TypeScript/28 Native transport PASS; new CLI1 PASS/6 RED (mode absent).
- #20799: normal1027 config7/7, Native transport28/28, Native runtime runner, tsc/focused lint PASS.
- Windows baseline run40342920960/job121642104880 at bea6655: actual SEA/installer reproduced exact QA085_EXISTING_V3_WAS_REMOVED; wrapper confirmed RED. This is not a fixed-installer PASS.
- Ruling: CI publication is a source candidate only; the Windows fix cannot be executed in the Linux app environment. Publish for existing Windows CI before making its PASS claim; no owner activation.

- One review:0 Critical/3 Important/0 Minor. Required fixes: strict checker receipt scalar types; concurrent config-writer protection; full default registry state/named-property preservation. Five real Windows regressions cover these findings before the one fix pass; no re-review.
- Own Windows diagnostic at543e69d: CLI4 PASS/2 FAIL because the test temporary path used a Windows8.3 alias rejected by unchanged realpath checks. Canonicalize the test root; do not weaken the loader. Production checker staging also needs a canonical owner path.
