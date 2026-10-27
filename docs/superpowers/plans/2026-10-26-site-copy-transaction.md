# Site Copy transaction implementation plan

> Implement inline with superpowers:executing-plans; one fresh whole-change reviewer after verification.

**Goal:** Implement the observed synchronous site Copy representation as a reusable MAIN-world acquisition component.

**Architecture:** Add a self-contained function beside the existing unavailable Markdown adapter. Preserve every existing default and capability flag. Capture a single synchronous API argument, restore hooks before awaiting immutable Blob data, then revalidate the exact turn/document.

**Tech stack:** Existing TypeScript, JSDOM, Node 22 normal RBridge execution and repository CI.

**Spec:** ../specs/2026-10-26-site-copy-transaction-design.md

## Constraints and review focus

No shared clipboard reads, DOM reconstruction, private application state, new permissions or production activation. Preserve bytes and descriptor ownership. Reject multiple/deferred calls, navigation, response mutation, oversized or unreadable Blobs and partial hook installation. Actual Windows/private app-shell and MAIN-world authority wiring remain NOT RUN.

## Task: exact Copy acquisition component

Files: modify src/browser/chatgptAssistantMarkdownCapture.ts and package.json; add tests/w1-v3-site-copy.ts.

- [x] Add behavioral tests for direct Clipboard.write/writeText and all rejection classes; observe RED against the exact pinned base.
- [x] Implement captureExactSiteCopyInMainWorldV3({assistantTurnId,documentUrl}) returning the existing SiteMarkdownObservationV3.
- [x] Run focused GREEN and existing unavailable-adapter tests under the normal RBridge app identity.
- [ ] Exercise the same serialized function on the public site and retain limits; run full exact-source CI and fresh review.
- [ ] Publish a stacked source candidate against the qualified V3 branch; preserve activation and capability gates.
