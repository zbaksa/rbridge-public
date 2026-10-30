# Original P01 pristine upgrade implementation plan

Goal: produce a qualified, target-bound owner kit and protected handoff for the original pristine P01 installation.
Spec: docs/superpowers/specs/2026-10-30-p01-pristine-upgrade-design.md
Base: actual R31d7e85a74eb15868cef557f74cc136490ea9be7 equals canonical6dc20d86ea06a678cc805bc1dac6862d437b356d tree10a20625765a9653593a1887500cd52a681f83f2. Actual C79409217059acdd1d7c52cb5807c469d0284bbc0 equals canonical0e206589b8544393fb7eca5929770a7c57caf3e1 treedb0508cff58a5c93e9b837b2b70f11acfe091ff3.

Global constraints: preserve the exact original scope/identity/roots and all uncertainty. Only a pristine owned predecessor is eligible. No runtime-owner-parser relaxation, generic history migration, Root execution, source-pin spoof or new namespace. APP source/Git/test/build run only under actual own UID through authorized APP_RUN relay; existing worktree qualification.lock serializes operations. Static Scratch review is allowed. Do not touch existing real931e fixture bytes. Full App qualification is run once after all tasks freeze, not duplicated by each worker.

Task1 R kit and Chrome continuation
Files: scripts/p01-owner-v3-kit.mjs, scripts/p01-owner-setup.html, scripts/p01-owner-setup.js; focused Node/VM tests under tests; original public config input if needed under ops/p01-owner-generated.
Consumes: original exact config/startup preimages; final source/tree proof and verified Native artifact metadata.
Produces: provisioned V3 extension, new startup, resource hash manifest and Windows kit inputs; fixed filenames setup.html/setup.js/p01-startup.json and existing six-resource read-only export contract remain.
Steps: read31b7 known setup sources and current build/profile APIs; add tests and observe behavior RED; implement exact original-startup/pristine continuation, preservation and failure recovery; test replay/collision/local-history/concurrent-write/partial receipt and source/tree/artifact mismatch; run relevant suites, touched lint/typecheck/diff; freeze source and full sourcepack. Do not commit/publish or run full suite yourself.

Task2 Windows pristine owner executor
Files: a new separately named scripts/upgrade-p01-pristine-native-windows.ps1 and CMD entry template, focused Windows tests, required early Windows workflow test hook (coordinate exact workflow edits with root).
Consumes: Task1 target package manifest plus exact predecessor pins from spec.
Produces: guarded original-P01-only executor and durable old-to-new report/backup semantics. Existing legacy upgrader is unchanged.
Steps: reuse verified Windows safe-handle/ACL and transaction patterns; write behavior tests and arrange genuine Windows RED before implementation via root if host cannot execute them; implement pinned preflight/registration/exclusion/full pristine store and immutable backups; candidate config validation must not connect; publish journal phases with readback and crash/replay recovery; negative tests for every preimage/ACL/reparse/history/writer/partial state. No owner execution. Return frozen changes and exact RED/GREEN evidence; root owns final full suite/publication/artifact staging.

Task3 Linux Root and C tuple (after final R source/hash)
Files in C: separate new P01 fixed upgrade operation/tests, existing bootstrap exact release pins and focused tests, packaging/normal compiled-manifest generation as needed.
Consumes: final R source/tree/App release manifest, actual C-built fixed SSH ELF and exact old protected/private preimages.
Produces: reviewable source, synthetic operation tests and hash-pinned staged owner Root packet. Both peer/result kernel gates, fixed entry and same root identity must be validated; retain original raw config/marker backups and recoverable receipt. Current expected fixed SSH command is /usr/local/libexec/rbridge-chat-stdio-v1, no args; do not modify authorized_keys. Source operations only until review and actual owner execution.

Task4 qualification/publication then actual activation
Integrate test/build/workflow wiring, run one full actual App qualification, independently review complete diffs and fix real issues, commit App sources and publish exact-tree canonical Drafts. Freeze R first to avoid self-SHA cycles, build/verify actual owner V3 kit and Windows executable on exact canonical source, then pin/qualify/publish C. Stage concrete Root packet; read actual Linux COMPLETE before presenting Windows CMD kit. Final genuine owner Windows/Chrome provenance and one prompt/fullcapture/STOP are separate acceptance.

Review focus: changed preimages during awaits; Windows partial publication/start exclusion; browser partial multi-key writes and restart; source/tree/artifact identity confusion; retained or unexpected history wrongly classified pristine.
