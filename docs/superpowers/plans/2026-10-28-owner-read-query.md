# Existing Owner Read Query Implementation Plan
> **For agentic workers:** execute continuously with TDD; R component may run independently while primary implements C client. One fresh whole-change final review, no duplicated component reviewers.
**Goal:** Make two existing read-only browser operations reachable through fixed Linux peer and Cocwin App client.
**Architecture:** Existing V1 commands/results carried by existing V3 peer spool and fixed CLI. No new browser/native protocol or effects.
**Tech Stack:** Existing TypeScript/Node22/Vitest, actual AppUID1027/1023 execution, GitHub source/evidence.
**Spec:** docs/superpowers/specs/2026-10-28-owner-read-query-design.md

## Global Constraints
All schema/method/hash/TTL/budget values and live invariants are the spec. Preserve installed sources/config/state; source qualification is not deployment or E2E. No new dependency, controller, scheduler, registry, provider call or SEND. Never expose secrets. All Git/build/test app-owned on aether-engine; scratch text editing only.
## Review Focus
- A completed query from an old channel or expired nonce never becomes fresh authority.
- A read command cannot reserve/dispatch a V3 effect or collide with one.
- Legacy journal/effect/history and uncertain IDs survive query writes/restart unchanged.
- Mutable input/result aliases, cross-process calls and replays retain exact correlation.
- Discovery/state do not imply actual generation, capture readiness or remote quiescence.

### Task1 R fixed peer lane (independent)
Files: create src/domain/rbridgeReadQuery.ts; modify src/server/rbridgeChatPeerStore.ts and rbridgeChatPeerCli.ts; stdio type flow only if needed; add focused real-store/stdio tests.
Interfaces: exact builder/record/store/CLI contract in spec.
- [ ] Test-only commit on R browser931e baseline; actualUID1027 RED for unsupported submit-query and real roundtrip/result rejection. Observe expected existing denial, not missing dependency.
- [ ] Implement minimal read-only lane, additive bounded journal metadata and original-record validations. Never reserve an effect.
- [ ] Actual focused GREEN + related peer/Native/worker compatibility; independent typecheck/lint, full R suite/build. Preserve exact head/tree and original JSON/digests. No production install.
- [ ] Report final head/tree/files/risks for combined fresh reviewer; no extra reviewer spawned by implementer.

### Task2 C existing transport client (primary)
Files: src/server/rbridgeAppPeerTransport.ts; new small mirrored domain read-query validator/builder if needed; existing transport tests.
Interfaces: consume exact query/record and fixed submit-query/read-query CLI. No readiness callback granting.
- [ ] New isolated actualCocwinUID1023 worktree/branch from unchanged qualifiede9, same-lockfile dependencies; preserve prepared original.
- [ ] Test-only commit; actual App RED for missing query methods, command envelope/correlation and stale rejection.
- [ ] Add smallest existing-transport extension. Use original immutable request/result and fixed installed code only; no arbitrary cwd/entry/operation or new auth.
- [ ] Actual targeted GREEN/type/lint/full changed-head canonical CI. No activation.

### Task3 integration qualification
- [ ] One fresh-context review over both complete changes, spec, rulings and actual RED/GREEN evidence; one Important/Critical regression-first fix pass if needed.
- [ ] Exact-head source/artifact qualification, isolated draft PRs on appropriate browser snapshot/stacked C base; no main rewind/integration.
- [ ] Read existing R Linux installer/privilege contract and prepare narrow frozen install ONLY if necessary and supported. No Root/cap/sandbox bypass or repeated rc71.
- [ ] Once physical channel restored, bounded actual discovery/state read through qualified installed lane; keep unsupported capture/quiescence UNKNOWN and canonical policyNONE until genuine canary prerequisites.

Ruling: owner explicitly opted out of confirmation questions and authorizes necessary source work. Reuse supported read commands before proposing a new multi-host snapshot protocol. Distinct repositories can implement their frozen interface in parallel; one combined final reviewer retains integration scrutiny.
Ruling: original R source origin is a local seed. Use immutable qualified931e, not seed main5ca or unrelated public relay main5454. Actual fresh R worktree/dependency proof22751; all direct versions/lock and app ownership verified. No unchanged full baseline CI repetition.
Ruling: own App auth is already available through its existing scoped credential; actual22750 proves200/PASS and cross-app403. Prior missing WM_TOKEN environment was not proof of missing API authority. Keep credential inside normal App process.

Task1 actual RED: test-only a48443ba09d51f5f86b952f43cfd395d6f871718/tree219ac76bee1ee45e051cabb5356f4c4b4c36aac2; actual RBridge1027 proof22753, 27 expected focused failures and independent typecheck PASS. Implementation qualification pending; no activation or readiness claim.
Ruling: expiresAt is exclusive: now>=expiresAt is stale, including a completed result. Preserve optional legacy journal shape until an intentional query write. Effect dispatch order and existing budgets remain unchanged.
