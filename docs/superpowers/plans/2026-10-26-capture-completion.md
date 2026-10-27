# Durable site capture completion plan

Execute inline. Use one fresh whole-change review after targeted qualification.

Base: canonical RBridge `57d8d6cb55ce76c6b676b34cd5b30252f3ccdc05`, tree `856bc5d9174d98ae107b078093763b5ddabf70a5`.

Files: browserAuthorityRuntime.ts, rbridgeCaptureEgress.ts, tests/w1-v3-capture-completion.ts, package.json and this spec/plan.

- [x] Reproduce blocked next SEND and missing runtime completion against the exact canonical base.
- [x] Add validated, fenced and read-back runtime completion.
- [x] Complete only a durable site-acquired response; replay safely after a partial failure.
- [x] Qualify targeted behavior and existing related suites under normal RBridge identity.
- [ ] Review once, fix regressions, run full exact-head CI and integrate verified source.

Initial RED [#20554](https://github.com/zbaksa/cocwin-private/issues/20554): 8 expected failures, 4 existing safety behaviors passed. Added direct-cache provenance regression [#20557](https://github.com/zbaksa/cocwin-private/issues/20557): 9 expected failures, 4 passed. No production operation or AI SEND occurred.

GREEN [#20559](https://github.com/zbaksa/cocwin-private/issues/20559), normal RBridge UID/GID 1027, Node 22.23.2: 13 completion +18 reader +20 capture-egress +24 browser-effect tests, source typecheck/build, focused lint and diff check passed. The three consecutive cycles use the real runtime, effect ledger, delivery proof and capture egress with synthetic send/reader boundaries. They are not owner-browser acceptance.

One fresh review found 0 Critical, 1 Important, 0 Minor: an intervening raw capture bypassed the initial cache check. Reproduced all three interleaving windows in [#20560](https://github.com/zbaksa/cocwin-private/issues/20560), with 13 passing and 3 failing tests. Fixed final Copy admission with a synchronous shared mutation fence, rechecked slot eligibility within site persistence, and required one exact site-owned record at completion. [#20561](https://github.com/zbaksa/cocwin-private/issues/20561): 16 completion +62 related tests, source build/lint/diff PASS under normal RBridge identity. The three race tests each exercise same/different captured, lost and rejected direct records. No repeat review.
