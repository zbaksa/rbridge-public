# RBridge Development History

This document is the public chronological development record for RBridge.

It complements:

- `CHANGELOG.md` — concise release/product changes;
- `docs/KNOWN_ISSUES.md` — known limitations and resolved issue notes;
- Git history / pull requests — exact implementation diffs.

The goal here is different: preserve **when important capabilities were added, when important defects were discovered and fixed, and whether source acceptance and live deployment acceptance were both complete**.

## Recording rules

For every material change, record when relevant:

- date (UTC);
- milestone/version line;
- feature, bug or security/recovery issue;
- what changed;
- PR and/or commit;
- CI status;
- deployment status when separately verified.

Do not put private hostnames, credentials, private repository names, tokens or internal product names in this public history.

### Status terms

- **SOURCE PASS** — merged source passed required verification/CI.
- **STAGED** — an immutable deployment artifact was built/staged.
- **DEPLOYED** — a live deployment accepted the new release.
- **HELD / BLOCKED** — deployment intentionally did not continue because a safety gate failed or found unresolved state.
- **ROLLED BACK** — live deployment returned to the prior accepted release.

---

## 2026-10-04

### Read-only durable-state cutover audit

**Type:** V1 operations / upgrade safety

Added a read-only audit utility for upgrades that change durable identity/scope semantics.

The audit:

- correlates unresolved durable records with their GitHub Issues;
- distinguishes trusted open work from closed historical evidence;
- checks issue identity instead of trusting state alone;
- counts active process sessions;
- returns PASS / BLOCKED / UNKNOWN without deleting, rewriting, closing or terminalizing anything.

This was added to resolve production-upgrade gates without weakening RBridge's durable-history guarantees.

**Source status:** **IN QUALIFICATION**

---

### RBridge 2.0 P0 contract & security freeze

**Type:** V2 architecture / security contract  
**PR:** [#23](https://github.com/zbaksa/rbridge-public/pull/23)

RBridge 2.0 implementation began with a transport-neutral contract freeze before MCP runtime code.

The P0 candidate defines:

- one normalized operation identity across transports;
- principal + target-instance trust scope;
- transport authentication separated from core authorization;
- acceptance TTL separated from durable recovery;
- a monotonic CLAIMED / AUTHORIZED / STARTING / RUNNING / TERMINAL phase graph;
- explicit no-blind-retry / UNCERTAIN semantics;
- cancellation evidence separated from rollback claims;
- execution receipts with policy snapshot, transitions and postconditions;
- SAFE-only 2.0 capability scope.

The public roadmap was corrected so **2.0.0 targets SAFE**, WORKSTATION moves to 2.1 after isolation is proven, and FULL ACCESS/GUI remain later work.

**Source status:** **SOURCE PASS**

---

### V1 recovery and duplicate-effect safety hotfix

**Type:** reliability / security / recovery hotfix  
**PR:** [#19](https://github.com/zbaksa/rbridge-public/pull/19)  
**Main commit:** `3762e92530fcf147588e4d08781d98ffe7508417`  
**Qualified hotfix head:** `fe4b1e6232b4755479b6c1b3c7317f62b1999e97`

Confirmed defects fixed:

1. **Mutating FILE operations could be executed twice after interruption.**  
   A crash after the filesystem side effect but before terminal-result persistence could leave the request `SUBMITTED`; replay could perform the mutation again. Mutating FILE recovery now fails closed as uncertain instead of blindly repeating the side effect. Read-only FILE recovery remains replayable.

2. **Global relay lock publication had a race window.**  
   Another process could observe an incomplete/empty lock file and incorrectly classify it as stale. Lock metadata is now published atomically and incomplete lock metadata fails closed.

3. **Request expiry could stop tracking already accepted work.**  
   Acceptance TTL is now separated from recovery/tracking. A durable request that was accepted before expiry can continue reconciliation after its original request TTL has elapsed.

4. **Transient controller contention could become terminal `BLOCKED`.**  
   Known temporary busy/resource-contention conditions remain non-definitive so active work is not incorrectly terminalized.

5. **Durable replay was not scoped to the configured trust target.**  
   Durable request identity is now bound to repository, trusted author and target-instance scope so changing deployment identity cannot silently replay a previous environment's result.

6. **Base systemd template did not match the shipped FILE policy.**  
   The template no longer requires an unrelated private environment file and now permits writes to the shipped `/mnt/data` FILE root under `ProtectSystem=strict`.

7. **Bounded issue processing could starve later requests.**  
   Request selection now rotates fairly instead of repeatedly selecting only the same first bounded subset of open requests.

8. **FILE path validation had a local path-swap/TOCTOU window.**  
   Linux FILE operations were hardened around verified file/directory descriptors so a local path replacement after validation cannot silently redirect an operation outside the allowed root.

Regression coverage was added for the corresponding recovery, lock, scope, expiry, contention, fairness, systemd and file-path cases.

**CI:** two exact-head workflow runs completed successfully:

- `37206701643` — PASS
- `37207562330` — PASS

**Source status:** **SOURCE PASS**

#### Maintainer deployment preflight

The exact hotfix source was rebuilt on the maintainer deployment host:

- 32 test files passed;
- 201 tests passed;
- typecheck passed;
- lint passed;
- server build passed;
- public-source scrub passed;
- immutable release was staged.

The live cutover was intentionally **HELD** because preflight found 97 historical durable records still in `SUBMITTED` state. The accepted production release remained unchanged. This is intentional fail-closed behavior: deployment must not reinterpret or discard unresolved durable work merely to complete an upgrade.

**Deployment status:** **STAGED / HELD pending durable-state resolution**

---

### RBridge 2.0.0 product plan defined

**Type:** roadmap / architecture  
**PR:** [#18](https://github.com/zbaksa/rbridge-public/pull/18)  
**Commit:** `73ccea7e68d5475ebdb2eb9fee719e42c3021bdd`

The public 2.0 plan established:

- one RBridge core rather than separate product forks;
- SAFE as the default policy;
- MCP as a transport rather than a permission level;
- future WORKSTATION and FULL ACCESS modes as explicit capability layers;
- vendor-neutral cloud/free/local AI compatibility targets;
- Windmill as the recommended optional public orchestrator;
- optional funding/donation support without paywalling core capability.

**Status:** **SOURCE PASS**

---

### Public orchestration documentation moved to Windmill

**Type:** public product positioning  
**PR:** [#17](https://github.com/zbaksa/rbridge-public/pull/17)  
**Commit:** `442fd1aee5c34ae5d75c03e57f2523b63daf1dc1`

Public-facing orchestration guidance was simplified around Windmill using the existing GitHub request/result transport.

Private orchestration/product references were removed from the public product story. Exact legacy wire literals that were still required by the runtime were left only where necessary for protocol compatibility.

**Status:** **SOURCE PASS**

---

### Public repository productization

**Type:** documentation / onboarding / community  
**PR:** [#16](https://github.com/zbaksa/rbridge-public/pull/16)  
**Commit:** `5ab2a10fd26816314cffc69efa61b421ea49aeeb`

The repository was expanded from a thin technical source tree into a usable public product surface:

- product README and capability positioning;
- Quick Start;
- installation guide;
- architecture;
- security model;
- configuration reference;
- protocol reference;
- operations;
- troubleshooting;
- comparison with Desktop Commander, SSH and MCP;
- FAQ;
- roadmap;
- contribution guide;
- changelog;
- security policy;
- issue templates.

**Status:** **SOURCE PASS**

---

### Standalone production cutover completed

**Type:** production migration / acceptance  
**Source commit:** `f15f690b33ff16b0de89d54dee81de1577deb97f`  
**Source tree:** `4351ea656264c9efa281058daa83b26f6c1665a8`  
**Exact-SHA CI run:** `37197335367`

A standalone RBridge service replaced the previous legacy bridge after:

- durable-store migration;
- fresh probe acceptance;
- policy-health acceptance;
- continuous-qualification acceptance;
- snapshot-refresh acceptance;
- service/listener audit;
- final acceptance receipt;
- restart/PID stability check.

The public main branch was promoted only after all acceptance gates passed.

**Deployment status:** **DEPLOYED**

---

### Current workflow contract parity completed

**Type:** compatibility / execution contract  
**Commit:** `f15f690b33ff16b0de89d54dee81de1577deb97f`

The public source incorporated the complete workflow action set that was required for standalone runtime parity at that point, with deployment-configured endpoints rather than private host hard-coding.

**Status:** **SOURCE PASS**

---

## 2026-10-03

### Deployment-configured policy endpoint

**Type:** portability / public-source safety  
**Commit:** `0c967e369ca2e995e7b9f551161b6298a373ec1a`

A deployment-specific endpoint was moved from compiled/public identity into runtime configuration, preserving the public repository's host-neutral design.

**Status:** **SOURCE PASS**

---

### Policy-health workflow compatibility

**Type:** workflow compatibility  
**Commit:** `3ee56e181f428f9959e8eca9661a929d7bd06f8d`

Added the bounded policy-health compatibility contract and tests required by the standalone runtime path.

**Status:** **SOURCE PASS**

---

### Standalone workflow ingress/runtime integration

**Type:** runtime integration  
**Commit:** `b181075dcd27f315de33a9cd8357bcf1573b608c`

Integrated the optional workflow execution bridge into the standalone RBridge runtime while preserving independent primary transport operation.

**Status:** **SOURCE PASS**

---

### systemd entrypoint correction

**Type:** deployment bug fix  
**Commit:** `476a99e2c621c9c4a0c1842fb22078034eaabff2`

Corrected the standalone service entrypoint path in the deployment template.

**Status:** **SOURCE PASS**

---

## 2026-09-28

### Public-neutral test/lint cleanup

**Type:** public-source hygiene  
**Commits:**

- `bfee73b5348c7b15446598b0866ba523d524b661`
- `b7961f2c27da688e14023db48873db23e220dc25`

Improved public-neutral host checks and prevented internal worktrees from polluting lint verification.

**Status:** **SOURCE PASS**

---

## 2026-09-27

### Standalone systemd service template

**Type:** deployment  
**Commit:** `df6fba461fc2bab4c3594296dbf0b0c00a7e56d0`

Added the standalone hardened systemd service template.

---

### Configurable runtime identity

**Type:** deployment/security  
**Commit:** `0b75647c2b2d0eab671bd3bdf4d1493090c7ce65`

Removed a fixed runtime identity assumption and made the runtime user an explicit deployment contract.

---

### Durable uncertainty handling

**Type:** recovery/reliability bug fix  
**Commit:** `2c8e931d978e906674fa1cbbf8cb6ed149d95d82`

Preserved uncertain application execution as durable uncertainty instead of inventing a definitive result.

This is an important RBridge invariant: a lost acknowledgement after a possible side effect must not automatically become a safe retry.

---

### Browser test lab

**Type:** testing/tooling  
**Commit:** `6ec3f8335ad402ee89691409a2444b726195e402`

Added Playwright-based browser test-lab coverage.

---

### Digest-bound binary file operations

**Type:** FILE capability / integrity  
**Commit:** `343e27a476a8c1a43901bed051577e4fa9ba2948`

Added bounded binary file operations with SHA-256 binding.

---

### Deterministic evidence packs

**Type:** evidence/auditability  
**Commit:** `ab126efca1218b19d274f1b10a1f787ce1240628`

Added deterministic evidence-pack support.

---

### Public release candidate prepared

**Type:** public release preparation  
**Commit:** `5464c819430c4c154c0c86eee5b7acac78135519`

Prepared the first substantial public RBridge release-candidate line.

---

## 2026-09-26

### Frozen Stage-2 source extracted

**Type:** repository/source extraction  
**Commit:** `087f9f5ab499667c4f2b13a7d1bb5827af614a2e`

Extracted the frozen standalone Stage-2 RBridge source into the public repository line.

---

### Public repository initialized

**Type:** repository milestone  
**Commit:** `ed4d0e4ecf75680b9f28f1d2ff4d8baf77e2d0c9`

Initial public repository commit.

---

## How to maintain this file

Update this history in the same PR when a change:

- adds/removes a public capability;
- changes a security boundary;
- changes durable/replay/uncertainty semantics;
- fixes a material bug;
- changes installation/deployment behavior;
- creates a release or production migration milestone;
- introduces a known compatibility break;
- materially changes the public roadmap/product architecture.

Small formatting-only changes do not need a history entry.

For exact implementation details, always use the linked commit/PR as the source of truth.
