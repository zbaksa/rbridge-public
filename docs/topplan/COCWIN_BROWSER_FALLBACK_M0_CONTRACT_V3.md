# COCWIN Browser Fallback — M0 Contract V3

Status: **FREEZE_PENDING_IMPLEMENTATION**. This contract prepares the approved integration; it does not enable a browser route or establish live acceptance.

Authority: approved design `01ef343c0a232d22cff5163e77abad78739a5d3b`, implementation plan `docs/superpowers/plans/2026-09-30-cocwin-m0-v3-integration.md`. Preserve historical V1/V2 records and source ownership: COCWIN owns lifecycle, context, W3 parsing, verification and promotion; RBridge owns browser operations and capture. Digests are integrity evidence, never peer authentication or model PASS authority.

## Exact boundary

Wire field sets are in `COCWIN_BROWSER_FALLBACK_M0_INTERFACE_CATALOG_V3.md` and `COCWIN_BROWSER_FALLBACK_M0_SCHEMA_CATALOG_V3.json`. All fields are required; unknown fields are rejected. The schema's `x-semanticConstraints` are mandatory validator requirements, including constraints JSON Schema cannot express.

1. Validators, not schema shape alone, recompute Canonical JSON V1 digests excluding only the respective self digest field.
2. Effect identity is SHA256 UTF8(session NUL generation NUL attempt NUL kind NUL decimal ordinal).
3. Payload variant must match effectKind; rollover next generation equals current+1 within 2147483647.
4. Exact project component uses the existing ChatGPT URL parser semantics; arbitrary prefix matching is forbidden.
5. Request AND command AND result AND complete event serialized JSON UTF8 bytes each fit the negotiated 4096..65536 ceiling including escaping.
6. Text limits count UTF8 bytes: prompt/result 48000, full assistant turn 16384; no normalization, truncation or selected fence.
7. Result validates the supplied full command independently and all seven command/request correlations.
8. VERIFIED requires full matching receipt and reason null. Binding leader/capture and verified SEND leader epochs are positive. Other states require a stable reason and may carry a matching negative SEND receipt.
9. Rollover receipt matches old request; nested new binding retains exact browser/profile/project/owner, uses successor generation and a different conversation ID.
10. CAPTURED validates receipt digest, full raw-text count/hash, envelope/receipt correlations and event digest. Capture request/conversation/epoch/peer and stream sequence are additionally checked at ingress.
11. REJECTED omits text: MACHINE_RESPONSE_TOO_LARGE iff count>16384, otherwise OUTPUT_BUDGET_EXCEEDED. The omitted original text cannot be independently reconstructed from a rejection receipt.
12. HELLO major 1 is authenticated and pinned before constructing VerifiedPeerV3; minor>=1 and all ten capabilities are required for V3. No implicit downgrade.
13. Plain JSON data is snapshotted before asynchronous digests; unknown/missing keys, accessors, symbols and non-data prototypes are rejected.
14. Legacy V1 readers retain their meanings and cannot authorize the V3 parser lane. No runtime capability is advertised by this contract-only work.

## Durable execution and capture obligations

Before dispatch, COCWIN durably persists complete immutable effect requests, app/base scope and request digest. Replays reuse original identity/bytes; collisions fail closed. RBridge persists effect outcome and SEND intent before a click. RECONCILE is read-only, remains available while mutation is pending and cannot clear uncertainty by time or replace EXECUTE. COCWIN waits at most 10000 ms for EXECUTE and 5000 ms for RECONCILE; a timeout releases only its waiter. Remote mutation reservation survives, late replies are journaled and a later tick reconciles.

The capture representation is the site's original complete Markdown from the exact terminal assistant turn. Original fences/info strings/order, prose, indentation and LF/CRLF are preserved. textContent reconstruction, unrelated clipboard, stale/global exports, user/tool text and machine-block selection cannot provide this authority. Missing provenance yields CAPTURE_LOST/UI_PROTOCOL_CHANGED before W3. Real availability must be proved before advertising the capability.

Task 1 validators do not implement durable stores, authenticated transport, browser adapters, W3 ingress or runtime wiring. These remain subsequent plan tasks. Historical event streams and unresolved SEND survive upgrades.

## Independent compatibility fixture

Both repositories carry identical fixed `tests/fixtures/rbridge-cocwin-contract-v3.json` bytes: SHA-256 `8c77656e4783ecda0067417f3cd795bee667cdc39445f30028afb40cbbf02f2c`. Python literal inputs/stdlib hashes are precomputed independently. Runtime tests never regenerate expectations using the validators. The fixture includes all four effects, full receipts, byte-exact Markdown, a 16384-byte U+0001 turn whose serialized event is 99631 bytes, distinct bounded rejections and maximal ASCII metadata at 2299 bytes. Implementation byte limits still validate every actual message, including UTF-8 IDs.

Freeze and enabling depend on the versioned merge gate; source tests alone are insufficient.
