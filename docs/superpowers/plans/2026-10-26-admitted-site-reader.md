# Admitted site reader implementation plan

> Execute inline; use one fresh whole-change review after targeted qualification.

**Goal:** Connect the exact Copy transaction to the real V3 authority and durable capture egress.

**Architecture:** Add a Chrome site reader beside existing Chrome adapters. Add an optional acquisition dependency/entry to existing egress and a strictly parsed internal request branch. Preserve existing default startup and capability availability.

**Spec:** ../specs/2026-10-26-admitted-site-reader-design.md

**Files:** src/extension/chromeAuthorityAdapters.ts, src/extension/rbridgeCaptureEgress.ts, tests/w1-v3-site-reader.ts, package.json.

**Review focus:** wrong document/frame/profile; current-user/assistant pairing; authority changes across awaits; durable replay and failure; fabricated completion or cross-app scope.

- [x] Add behavioral RED tests against exact148d source under normal RBridge identity.
- [x] Implement self-contained pair probe and document-targeted Chrome reader.
- [x] Implement authority-bound egress acquisition, coalescing, replay and internal request handling.
- [x] Run targeted GREEN, existing related suites and real Chrome API fixture where supported.
- [ ] Review/fix, full exact-head CI, integrate and verify the exact promoted source.

## Qualification before canonical CI

Normal RBridge UID/GID 1027/1027, Node 22.23.2, exact base `148d33a5d8ca6d3b9028149f393af62bda16655b`:

- Initial behavioral RED: [#20460](https://github.com/zbaksa/cocwin-private/issues/20460). Navigation regression: [#20468](https://github.com/zbaksa/cocwin-private/issues/20468).
- One fresh whole-change review: 0 Critical, 2 Important, 1 Minor. The mixed SEND history, hanging Chrome operation and cross-instance duplicate acquisition were all reproduced in [#20504](https://github.com/zbaksa/cocwin-private/issues/20504), then fixed.
- GREEN: [#20508](https://github.com/zbaksa/cocwin-private/issues/20508), 18 new reader tests, 20 capture-egress tests, 24 exact-Copy tests and 10 delivery-content tests; full source typecheck/build, focused lint and diff check passed. Timeout tests cover a hanging tab read, hanging isolated probe and a late MAIN copy; no late event or second acquisition is accepted.
- Actual Chromium 153.0.8010.12 extension API: [#20513](https://github.com/zbaksa/cocwin-private/issues/20513). An offline fixture exercised real `chrome.scripting.executeScript`, ISOLATED/MAIN worlds, frame 0 and Chrome document IDs. Exact 44-byte BOM/UTF-8/CRLF Markdown was retained; wrong user and navigated document were rejected without Copy; a new document succeeded. Authority/DOM were synthetic; no AI provider request or SEND occurred.

Production startup, response lifecycle completion, Native peer provisioning, private ChatGPT app-shell and owner Windows remain unqualified. Source and offline fixture success do not enable the availability flag.
