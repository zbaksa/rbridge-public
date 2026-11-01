# Claude fence runtime opt-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Make the existing opt-in envelope reachable through strict process configuration, disabled by default.
**Architecture:** One environment resolver in remoteBridgeMain.ts supplies allowClaudeFence to the existing worker. Existing admission and transport validation stay in place.
**Tech Stack:** TypeScript, Node 22, Vitest.
**Spec:** docs/superpowers/specs/2026-11-01-claude-fence-runtime-optin-design.md

## Global Constraints
- No dependencies, live enablement, COCWIN modification or protected original replay.
- RBRIDGE_ALLOW_CLAUDE_FENCE accepts only absent/"0"/"1"; all other values fail startup.
- Mandatory pinned HOLD is constructed before any worker intake.
- Formal source/CI, installed files, loaded policy and production GO are separate evidence.

## Review Focus
Actual main-to-worker wiring, absent/default configuration, malformed environment, HOLD bootstrap failure, and protected APP_RUN admission. The task below pins all five; no untested implied input classes identified beyond existing parser/worker negative suites.

### Task 1: Complete the process option
**Files:** src/server/remoteBridgeMain.ts; tests/server/remote-bridge-main-claude-optin.test.ts; docs/CLAUDE_FENCE_RUNTIME.md.
**Interfaces:** consumes existing createRemoteBridgeWorker options; adds resolveRemoteBridgeClaudeFenceConfig(env: Record<string,string|undefined>): boolean.

- [x] Add real-main integration cases: framed HEALTH blocked absent/"0", PASS at "1"; plain HEALTH PASS by default; malformed switch throws before polling; held APP_RUN stays WAITING at "1"; forged author blocked; HOLD initialization failure prevents intake.
- [x] Run targeted file and observe missing runtime wiring/validation as RED.
- [x] Implement the strict resolver and pass its result to the real worker, keeping HOLD initialization mandatory.
- [x] Run targeted and existing parser/routing/HOLD tests as GREEN.
- [x] Document source configuration and the separate deployment gates.
- [ ] Run Node22 full suite, typecheck, lint, server build, scrub and diff check; retain environmental failures by name and require exact-HEAD dedicated CI.
- [x] Commit; perform one independent branch review; fix Important findings with regression-first tests; publish a Draft stacked PR, without merge/deployment.

## Execution checkpoint

Implementation and the real-main regressions passed RED/GREEN. Node22.23.4 targeted48/48 PASS; local full248/256 retains the same eight existing PROCESS socket-denial failures as the231/239 baseline. Typecheck, lint, server build, public scrub and diff check PASS. One independent read-only review of implementation commit757d3b71b694ec524ac90bcf770136089cf115e7 found no Critical, Important or Minor findings. Live host authority and production GO were outside that source review. Exact-HEAD dedicated CI is required before source qualification; this branch remains Draft with no deployment.
