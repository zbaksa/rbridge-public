# SDD ledger — plan: docs/superpowers/plans/2026-10-23-v3-native-port.md

Pre-flight: one task; shared interfaces are the existing V3 validators/types.
Ruling: extend the existing Native Port link only; do not compose unprovisioned
runtime authority — this fixes a necessary transport boundary while keeping
actual browser execution closed; cost: D0 remains blocked until later composition.
Ruling: use a Git-blob verified local subset for targeted diagnostics, then normal
RBridge app qualification — local Node24 is supplemental; cost: if app execution
is unavailable, canonical typecheck/full-suite qualification remains BLOCKED.
Owner root observation remains NOT RUN. Source changes do not grant installation.

Task1 RED: Node24 supplemental transform, pinned base:5 PASS/10 FAIL across15
behavior cases; missing V3 routing/result API reproduced before implementation.
Task1 Ruling: result-correlation test now expects the existing validator's exact
AGENT_RESPONSE_CORRELATION_MISMATCH code, not an invented RBRIDGE_ prefix — source
inspection confirmed the unchanged validator; cost: no new error namespace.

Fresh whole-change review of80bbc19 found one Important issue: a handler could
resume after a new HELLO/reconnect and send an old result into the new epoch.
Three regressions were added first (missing admission, HELLO, reconnect): watched
15 PASS/3 FAIL. Result sending is now bound by WeakMap to the actual originally
delivered command object and its admission epoch; cloned/fabricated commands do
not acquire transport authority. Upper-layer historical reconciliation remains
separate. Cost: consumers must retain the original callback command reference.

Related falsification: handler mutation/re-signing of that same object could
replace its admitted correlation. Watched18 PASS/1 FAIL; the context now retains
a private original command snapshot for result validation. Final local19/19 GREEN.

Canonical source/app qualification: pending. Local final19/19 is supplemental.
The post-review fix was checked by the implementer, not re-reviewed. No production
activation, credentials, installer or actual Windows browser execution occurred.

App qualification #19104 on206963c9: actual UID/GID1027, aether-engine, Node22.23.2.
Typecheck and complete test chain reached GREEN, including the new19/19. The
whole verify exited1 at lint: prefer-const in the new late-handler regression.
Changed that declaration to an explicitly typed const; no behavior changed.
Canonical checkout HEAD and tracked/untracked status stayed unchanged. Final
app qualification of the corrected source remains pending; no activation occurred.
