# RBridge M0 V3 staged installation

Status: **RUNBOOK_ONLY — INSTALLATION BLOCKED; I1/I2/I3 NOT_RUN**. Prepared 2026-10-02 for Task11 ownership. This document records source-supported prerequisites and readback gates; it does not authorize installation, activation, browser access or source effects.

## Exact source and existing evidence

The qualified R candidate is `zbaksa/rbridge-public@905d2b3af74907b575003b634e572f126e647025`, tree `9dafef94d4ce32b526cc56b4413d1682c16ed4ad`. Qualification belongs to this immutable head, separately from the current canonical checkout and any installed executable.

| Evidence | Observed result | Limit |
| --- | --- | --- |
| Normal R app source qualification [#12929](https://github.com/zbaksa/cocwin-private/issues/12929) | ROOT-qualified target 41 / full 259, typecheck/lint/build PASS under the normal R app identity | Source qualification; no installation/browser acceptance |
| [R Linux CI 37035289625](https://github.com/zbaksa/rbridge-public/actions/runs/37035289625) | Completed success; exact head `905d2b3…` | Dedicated CI identity `rbridge-ci`, runner `rbridge-debian-ci`; CI is not installed app identity |
| [R Windows CI 37035289612](https://github.com/zbaksa/rbridge-public/actions/runs/37035289612) | Completed success; exact head `905d2b3…` | Portable tests and SEA build; no owner-machine installation/connectivity |
| [Windows artifact 11240385425](https://api.github.com/repos/zbaksa/rbridge-public/actions/artifacts/11240385425) | Registry reports exact-head package, unexpired at inspection | Package contents/executable hash were not downloaded or independently read back in this runbook task |
| [Actual R read #12982](https://github.com/zbaksa/cocwin-private/issues/12982#issuecomment-5961085987) | Linux observation at `2026-10-02T20:38:48.258Z`, UID/GID 1027; no mutation/installation | Read transport PASS is not peer/service/browser readiness |

The Windows artifact name is `rbridge-native-host-windows-905d2b3af74907b575003b634e572f126e647025`; registry archive digest is `sha256:21925d8e12c5d713406f739f6a6cf13bafcad4ff4ecafb9a5730aaf326cc5bce`, archive size 34,325,859 bytes, expiry `2026-10-09T16:42:34Z`. This archive digest is distinct from the SEA executable digest and a complete compiled-file manifest. A retained immutable artifact binding and independently verified member bytes are still required.

Actual #12982 readback must remain separate:

| Actual observation | Value |
| --- | --- |
| R canonical source | `b7961f2c27da688e14023db48873db23e220dc25` |
| R canonical tree / cleanliness | `dd3db35613b0c998bfe9a33fbd74bff9accdbe05` / clean |
| `/var/lib/rbridge/runtime/SOURCE_SHA` | NOT_PRESENT; observed installed source remains null |
| `/etc/rbridge/chat-peer-v3.json` | NOT_PRESENT |
| `rbridge.service` | `User=rbridge`, `Group=rbridge`, `ActiveState=inactive`, `SubState=dead`, `MainPID=0` |
| Windows installation, owner route and native connectivity | NOT_INSPECTED |
| V3 exact-turn Markdown source | `SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3=false`; returns `UI_PROTOCOL_CHANGED`; W3 calls zero |

The missing legacy runtime marker does not prove the presence or absence of every immutable release directory. No qualified installed release, live fixed channel, Windows V3 configuration or real I1 is established by these observations.

## Stage 1: retain qualified immutable artifacts

Use existing qualified build routes, with locked dependencies and the exact candidate head, only in the authorized normal app/established repository CI context. These are source-defined routes, not commands executed by this documentation task.

| Artifact | Existing source route | Required independent binding before staging |
| --- | --- | --- |
| Linux fixed peer | `npm run build:server` emits `dist/src/server/rbridgeChatPeerCli.js` | Exact R head/tree, Node identity/version, entrypoint and every transitive emitted runtime file hash/count; qualified original build receipt |
| Browser extension | `npm run build:extension`; verifier requires `RBRIDGE_RELEASE_SHA` or exact `GITHUB_SHA` | `dist-extension/manifest.json`, `contentScript.js`, `serviceWorker.js` hashes/counts; release embedded in worker; exact extension ID/permissions |
| Native Host bundle | `npm run build:native-host` | Qualified `dist-native-host/rbridge-native-host.cjs` bytes and transitive provenance |
| Windows executable package | `npm run build:native-host:sea` on Windows; existing workflow stages installer and uploads package | Exact CI head/run/job/artifact, archive digest, actual executable SHA-256/count, metadata and installer member hashes |

The SEA script uses actual Node, pinned `postject@1.0.0-alpha.6`, checks a PE header, and exercises missing-config fail-closed startup. Its metadata schema `RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1` records executable hash/count and tool versions, but does not record source SHA. The complete source-to-byte association therefore requires the original exact-head CI/artifact readback. The bundle verifier checks embedded markers, syntax and missing-config startup; it is not an installed-byte verifier.

Do not replace a compiled manifest with an expected SOURCE_SHA, artifact filename, metadata PASS or supplied JSON hash. The inspected Linux workflow does not publish an immutable Linux runtime package, and the Windows package omits the extension. Existing artifact retention/publishing and a complete reviewed compiled-manifest binding must be settled before installation; their absence keeps dependent gates BLOCKED.

The golden V3 fixture at R905 and C `cb6255df9249d8639827f4c7e9ba20892cc06764` has identical Git blob `092bb78162d54736370cc73d88bf9be053b6a32f`. This identifies source-byte equality, not an installed artifact SHA-256 or live proof. Before a later canary, independently read the fixture/catalog hashes at its final exact C/R candidates and retain the original observations.

## Stage 2: Linux fixed-peer installation gate

The existing Linux entrypoint is `src/server/rbridgeChatPeerCli.ts`. It supplies these checks; the request cannot choose a release, executable or store root:

- Runtime platform Linux, effective identity non-root, username exactly `rbridge`. The previous normal R observation was UID/GID 1027; a later installed execution must independently read its actual identity.
- Root-owned `/etc/rbridge/chat-peer-v3.json`, regular single-link file, no symlink, no group/world write, 2–4096 bytes, exact realpath. Exact keys: `schema`, `releaseSha`, `releaseCwd`, `storeRoot`; schema `RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3`.
- `releaseSha` is the approved full 40-character head; `releaseCwd` equals `/var/lib/rbridge/runtime/releases/<releaseSha>`. Release and `dist/src/server` ancestor directories are root-owned, real, nonsymlink directories without group/world write.
- Actual cwd equals that immutable release; its `SOURCE_SHA` equals the approved head. Actual entrypoint realpath equals `<releaseCwd>/dist/src/server/rbridgeChatPeerCli.js`, regular/root-owned/single-link/no group-world write.
- `storeRoot` is an approved normalized absolute path. Its private R-owned root and `v3-peer-config.json` must be read back separately; the config uses canonical JSON plus newline, schema `RBRIDGE_CHAT_PEER_CONFIG_V3`, exact `scope`, `peerPins`, `initialHistory`. The runtime checks private mode/owner, exact app scope, peer pin digest, durable authority/history and replay continuity.

The immutable compiled manifest must be independently verified in addition to these marker/path checks: the CLI's SOURCE_SHA check alone does not attest all emitted bytes. Never reset or relabel existing journal/results/history to admit a new pin.

**Current gate:** `R_FIXED_PEER_INSTALLATION=BLOCKED`, with `RBRIDGE_PEER_INSTALL_CONFIG_UNAVAILABLE` from the absent configuration. No Linux installer, immutable-release provisioner, service unit installation or forced-command provisioning artifact was found in the complete 106-entry R905 Git tree. That source inspection does not establish which protected installed owner/helper routes exist on a machine; those routes were not inspected here. A reviewed concrete existing artifact/authorized route and exact inputs must be identified before any owner command is prepared. No sudo, shell wrapper, root-helper endpoint or manual file-copy recipe is supplied by this runbook.

An inactive `rbridge.service` is an observation, not authority to create/restart a unit. The source transport starts a fixed SSH stdio process; a unit PASS alone would not prove that transport.

## Stage 3: SSH forced-command and pinned channel gate

`src/transport/sshStdio.ts` launches SSH with `shell:false`, no TTY, BatchMode, strict host-key checking, identities-only, password/keyboard-interactive authentication disabled, the configured private identity and known-hosts file, user exactly `rbridge`, and remote command exactly `rbridge-chat-stdio-v1`.

The Linux stdio entrypoint requires the sole `stdio` argument and `SSH_ORIGINAL_COMMAND === 'rbridge-chat-stdio-v1'`. Before this gate can pass, the existing reviewed forced-command route must be independently read back: exact authorized key/principal restrictions, approved immutable entrypoint/cwd and effective identity, identity/host-key provenance, prohibited forwarding/TTY/other commands, and actual bounded end-to-end channel observation. Record references and hashes; exclude secret key bytes.

The fixed peer CLI supports only `stage-chunk`, `commit-command`, `read-result`, `read-event`, `inspect-peer` with bounded canonical-base64 JSON. The installed route supplies its store. These operations are not a new general command facility, and no runnable invocation is approved here. `inspect-peer` needs a current authenticated channel; CLI envelope PASS with null/missing/stale peer data cannot pass negotiation.

The store pins actual HELLO to trusted `scope` (`appId/baseSha/sessionId/generation`), `peerPins` (`peerId/releaseSha/browserInstanceId/browserProfileId/protocolMinor/maxMessageBytes/capabilities`) and original `initialHistory` (`sequence/eventSha256`). Require authenticated major-1/minor-1 negotiation, every V3 capability and the negotiated byte ceiling. Pin expected release to R905 only after independent installed-byte verification. Digests and structurally valid HELLOs alone do not authenticate the installed channel.

**Current gates:** `R_SSH_FORCED_COMMAND=BLOCKED`, reason `RBRIDGE_SSH_FORCED_COMMAND_UNAVAILABLE`; `PINNED_NATIVE_CHANNEL` remains BLOCKED/NOT_RUN. No forced-command installation proof was acquired.

## Stage 4: Windows owner installation gate

The existing `scripts/install-native-host-windows.ps1` is a V1 registration artifact. It checks selected executable/key/known-hosts existence, resolves SSH, copies the executable into the selected owner's LocalAppData installation, writes UTF-8 config/manifest, registers HKCU Chrome and Edge NativeMessagingHosts keys, and reads back manifest registration paths.

Its fixed host is `com.cocwin.rbridge_chat_v1`; allowed origin is exactly `chrome-extension://ebibbijpegoankenmggdnehpoadcophk/`. The extension manifest derives that ID from its pinned public key and limits permissions to tabs/scripting/storage/nativeMessaging and the approved ChatGPT host set.

The installer writes `RBRIDGE_NATIVE_HOST_CONFIG_V1` with `expectedExtensionId`, `eventStoreRoot` and `ssh`; it does **not** write the optional required-for-V3 `v3.scope`, `v3.peerPins`, `v3.initialHistory`. Its registration PASS neither proves executable provenance nor qualifies V3. Do not run its uninstall option or overwrite an existing installation/config/history.

The current parser supports those exact V3 fields, and `NativeV3PeerAuthority` binds owner/history, but parser support is not a provisioning route. No concrete existing reviewed route to supply V3 configuration or install the extension was established here. Do not invent an installer patch, Windows endpoint, signing service, browser login, clipboard fallback or manual config-copy step.

**Current gates:** Windows native host/extension installation are NOT_INSPECTED, with `WINDOWS_INSTALLATION_NOT_INSPECTED`; dependent channel/browser actions are NOT_RUN. If a later authorized read shows only V1 configuration, preserve `WINDOWS_V3_CONFIG_UNAVAILABLE`. Use `WINDOWS_INSTALLATION_ROUTE_UNAVAILABLE` only after observing an unavailable route, not as a claim about the uninspected machine.

Required future readback is actual Windows owner SID, process/executable/config/manifest/extension bytes and source bindings, effective ACL/owner restrictions, exact HKCU registrations, actual extension origin/ID, private store ownership/history, approved SSH/host-key pins and authenticated negotiated peer. Windows POSIX-mode checks do not attest ACLs. The native-host CLI uses an explicit `RBRIDGE_NATIVE_HOST_CONFIG` override or an executable-adjacent config; read its actual selected config, not a presumed path. No owner command is provided until these concrete artifact and route gates are reviewable.

## Stage 5: real I1 before I2/I3

R905 explicitly lacks a validated exact-turn site Markdown acquisition adapter. `acquireSiteAssistantMarkdown` returns `UI_PROTOCOL_CHANGED`; retain `LOSSLESS_MARKDOWN_AVAILABLE=BLOCKED`, reason `LOSSLESS_MARKDOWN_UNAVAILABLE`, no advertised live lossless-capture readiness and zero W3 calls. DOM text, code blocks, private app state or shared/manual clipboard do not substitute.

Task11's approved private collector must independently resolve original qualification, artifact, installation and live observation records. A valid evidence JSON document, SOURCE_FIXTURE result, CI identity, mocked peer or supplied LIVE label cannot grant runtime authority. Missing private binding stays `CANARY_RUNTIME_BINDING_UNAVAILABLE` and performs zero dependent actions. Runtime must be the separately frozen compiled canary and transitive manifest under the canonical normal C app identity (UID/GID 1023 observation required), without production activation.

Only after all installed prerequisites and a real delivery/Markdown route are proved may the separately authorized bounded I1 route run. Require actual session/negotiation/exact target/BIND/write leader/capture, original durable SEND intent, independently counted exactly-one SEND and matching verified receipt, original challenge-correlated full Markdown capture, durable COCWIN classification/W2 acceptance, and before/after canonical readbacks. Preserve the approved isolated negative/restart/uncertainty campaigns and original operation identities; observation/reconciliation never blindly reissues an uncertain EXECUTE.

I1 is currently NOT_RUN. I2/I3 remain NOT_RUN with `REAL_I1_REQUIRED`; Task12 owns their future isolated changeset/promotion work after private bindings and existing route gaps are resolved. SOURCE_FIXTURE evidence cannot discharge this prerequisite.

Preserve R canonical `b7961f2c27da688e14023db48873db23e220dc25`, protected C production `2a15b13880b280e491f75c686e8e1363fb4a0d88`, all four enabled schedules and disabled manual target 76. Do not merge/activate solely to align head labels. This documentation proposal performs no APP_RUN/build/test, installation, inference, browser, source-effect or schedule action. The original source-only draft was reviewed by ROOT; registry, source path checks and full-tree provisioning absence were independently read back before persistence.

## Primary source anchors

All R links below are pinned to the qualified full head:

- [Fixed peer CLI/install checks](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/server/rbridgeChatPeerCli.ts), [peer store/config/channel](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/server/rbridgeChatPeerStore.ts), [stdio](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/server/rbridgeChatStdio.ts).
- [SSH launch](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/transport/sshStdio.ts), [native config](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/nativeHost/nativeHostConfig.ts), [private peer/history authority](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/nativeHost/nativeV3PeerAuthority.ts), [native invocation](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/nativeHost/nativeHostInvocation.ts), [selected config path](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/nativeHost/nativeHostCli.ts).
- [Windows V1 installer](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/scripts/install-native-host-windows.ps1), [SEA builder](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/scripts/build-native-host-sea.mjs), [bundle verifier](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/scripts/verify-native-host-bundle.mjs), [Windows workflow](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/.github/workflows/topplan-w1-windows-native-host.yml).
- [Extension manifest](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/extension/extensionManifest.ts), [compiled extension verifier](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/scripts/verify-extension-artifacts.mjs), [build scripts](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/package.json), [Linux workflow](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/.github/workflows/topplan-w1-ci.yml).
- [Golden vectors](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/tests/fixtures/rbridge-cocwin-contract-v3.json), [golden/negative validator tests](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/tests/w1-v3-contract.ts), [V3 interface catalog](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/docs/topplan/COCWIN_BROWSER_FALLBACK_M0_INTERFACE_CATALOG_V3.md), [merge gate](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/docs/topplan/COCWIN_BROWSER_FALLBACK_MERGE_GATE_V3.md).
- [Actual unavailable Markdown adapter](https://github.com/zbaksa/rbridge-public/blob/905d2b3af74907b575003b634e572f126e647025/src/browser/chatgptAssistantMarkdownCapture.ts), [ROOT-approved Task11 ownership/evidence addendum](https://github.com/zbaksa/cocwin-private/blob/1d286279954a8f0c081f3b7bfbb4504ff155b4f8/docs/superpowers/plans/2026-10-02-cocwin-task11-evidence-addendum.md).

Repository path: `docs/topplan/M0_V3_STAGED_INSTALLATION.md`. This is a documentation-only descendant of qualified R905; all runtime/source/artifact qualifications remain bound to R905. Installation remains BLOCKED.

