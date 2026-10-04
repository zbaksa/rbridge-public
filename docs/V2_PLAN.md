# RBridge 2.0.0 Plan

RBridge 2.0.0 expands the public product without abandoning the current fail-closed design.

The guiding rule is:

> **One execution engine, multiple AI clients, multiple transports, one security model.**

RBridge 1.x remains the conservative SAFE baseline. RBridge 2.x adds compatibility and convenience as explicitly selectable capability layers.

## Product shape

RBridge remains **one product and one core**, not separate forks.

```text
                        RBridge Core
                 durable + fail-closed engine
                            |
             +--------------+--------------+
             |              |              |
           SAFE        WORKSTATION      FULL ACCESS
          default         opt-in           opt-in
```

### SAFE — default

Preserves the current security philosophy:

- exact schemas;
- durable request identity;
- replay/collision protection;
- bounded FILE / PROCESS / CHUNK / HEALTH capabilities;
- source-controlled process profiles;
- explicit BLOCKED / UNKNOWN semantics;
- no arbitrary shell;
- no desktop-control capability.

### WORKSTATION — opt-in

Designed for people migrating from interactive AI-computer tools.

Adds:

- MCP transport;
- broader reviewed developer/tool profiles;
- richer file/search/edit/process workflows;
- Git, Node/npm, Python and similar developer capabilities where safely profiled;
- the same durable request/replay/audit model as SAFE.

Arbitrary shell remains disabled.

### FULL ACCESS — explicit opt-in

For trusted workstations, disposable VMs/containers, or users who consciously prefer convenience over the command-level boundary.

Adds an unrestricted-shell capability only after an explicit configuration opt-in.

The UI/docs must clearly state that enabling arbitrary shell removes one of RBridge's strongest command-level security boundaries. FULL ACCESS does not imply root; OS-account permissions still apply.

## V1 / V2 compatibility strategy

- Preserve/tag the current SAFE line as the stable 1.x baseline.
- Build 2.x from the same core rather than maintaining a separate product.
- SAFE mode in 2.x should remain behaviorally compatible with the 1.x safety model.
- New transports must not silently expand capabilities.
- Protocol namespace cleanup should be backward-compatible so current clients/deployments can migrate gradually.

## MCP becomes a first-class transport

MCP is the highest-priority 2.x addition.

Architecture:

```text
ChatGPT / Claude / Cursor / VS Code / other MCP clients
                         |
                        MCP
                         |
                    RBridge Core
                         |
              SAFE / WORKSTATION / FULL
```

MCP is a **transport**, not a security mode.

A client may connect over MCP while RBridge remains in SAFE mode.

Initial MCP tools should map to existing RBridge capabilities rather than bypass them, for example:

- health;
- file read/write/edit/search;
- process start/status/output/input/terminate;
- transfer/chunk helpers;
- reviewed application/tool profiles.

## AI-provider neutrality

RBridge 2.x should not depend on one AI vendor.

Target compatibility should include major paid/cloud clients and strong free/local paths.

### Major commercial/cloud clients

Examples to qualify/document:

- ChatGPT / OpenAI-compatible MCP clients;
- Claude / Claude Code;
- Cursor;
- VS Code / GitHub Copilot;
- Gemini/Google developer clients that support MCP.

### Free/open client targets

The public compatibility guide should include at least five strong free/open or no-subscription paths where practical, for example:

- VS Code with local/free model support;
- LM Studio;
- OpenCode;
- Cline;
- a current Google free developer client with MCP support.

Exact compatibility claims must be tested/documented against current releases rather than assumed.

### Local/offline AI

RBridge should work with local models whenever the MCP client can drive them.

Examples:

- Ollama;
- LM Studio local server/runtime;
- local Qwen-family models;
- local Llama-family models;
- local DeepSeek/Devstral/Gemma-class models where supported by the chosen client.

Goal:

```text
Local model -> local MCP client -> RBridge -> local machine/server
```

No cloud model should be required for core RBridge operation.

## Windmill orchestration

Windmill remains the recommended public workflow/orchestration option.

Preferred public path:

```text
Windmill -> GitHub request/result transport -> RBridge
```

Future Windmill helpers/templates should make HEALTH, FILE and PROCESS workflows easy without creating a separate private orchestration dependency.

RBridge must remain usable without Windmill.

## Desktop Commander migration path

RBridge 2.x should make migration straightforward for users coming from broad MCP computer-control tools.

Recommended onboarding:

```text
Choose operating mode:

1. SAFE          (recommended/default)
2. WORKSTATION   (MCP + broader developer capabilities)
3. FULL ACCESS   (explicit unrestricted-shell opt-in)
```

Migration docs should explain:

- which Desktop Commander-style workflows map directly to SAFE/WORKSTATION;
- which workflows require FULL ACCESS;
- what security boundary changes when unrestricted shell is enabled;
- how RBridge durability/replay/UNKNOWN semantics differ.

## GUI / desktop interaction

GUI automation is **not** a core 2.0 launch requirement.

Potential later adapter:

- screenshots;
- mouse;
- keyboard;
- clipboard;
- window/application focus;
- multi-monitor support.

Desktop control should be a separately enabled capability so it cannot silently broaden a headless/server deployment.

## Funding / donations

RBridge remains free/open-source. Donations are optional and must not gate core functionality.

V2 productization should add a clean support surface:

### GitHub Sponsors

- enable GitHub Sponsors when the maintainer account is ready;
- add the standard GitHub Sponsor button through `.github/FUNDING.yml`;
- allow one-time and recurring support where available.

### Ko-fi or similar fiat option

Provide a simple card/fiat path for users who do not want cryptocurrency.

The exact provider should remain configuration/content rather than a runtime dependency.

### Bitcoin / Lightning

Preferred implementation:

- BTCPay Server donation/payment page;
- Bitcoin on-chain;
- Lightning;
- avoid exposing a reused primary personal wallet address when a per-invoice/payment-request flow is available.

### Corporate sponsorship

Optional tiers may provide acknowledgement such as:

- sponsor name;
- logo/link in a sponsor section;
- acknowledgement in release notes or `SPONSORS.md`.

Sponsorship must not buy hidden execution capability or bypass SAFE-mode policy.

### Planned repository surface

When real funding accounts/URLs are ready:

- `.github/FUNDING.yml`;
- `DONATE.md` or `docs/SPONSOR.md`;
- small README "Support RBridge" section;
- optional `SPONSORS.md`.

Do **not** commit placeholder wallet addresses, fake sponsor URLs, or private financial identifiers.

## Proposed implementation patches

A practical 2.0 sequence:

### P1 — MCP foundation

- MCP server/adapter;
- tool discovery;
- local/remote transport choices as appropriate;
- configuration and authentication boundary;
- no capability expansion beyond SAFE.

### P2 — MCP capability mapping

- FILE;
- PROCESS;
- HEALTH;
- CHUNK/transfer helpers;
- structured errors/results;
- replay/durability preservation.

### P3 — WORKSTATION mode

- explicit mode selection;
- reviewed developer profile pack;
- migration-oriented defaults;
- SAFE remains default.

### P4 — FULL ACCESS shell

- separate module/capability;
- disabled by default;
- explicit acknowledgement/configuration;
- no silent fallback from profiled execution to shell.

### P5 — security/compatibility qualification

- negative/bypass tests;
- mode-boundary tests;
- MCP abuse/error cases;
- replay/collision/uncertainty regression tests;
- compatibility tests for major AI clients plus free/local paths.

### P6 — productization

- Desktop Commander migration guide;
- AI/client compatibility matrix;
- Windmill templates/examples;
- installer/release packaging improvements;
- funding/donation surface once real accounts are configured.

### P7 — launch & adoption

The large public launch happens **only after RBridge 2.0.0 passes all release and live-acceptance gates**. V1 can remain public for early adopters, but it should not be promoted as the finished cross-client product.

Required launch assets:

- signed/tagged GitHub Release with checksums and release notes;
- copy/paste installation path and first-success Quick Start;
- 60–90 second demo showing an AI client connecting through MCP and completing a real SAFE-mode task;
- a second demo showing RBridge's core differentiator: disconnect/retry/recovery without blindly duplicating a side effect;
- Desktop Commander → RBridge migration guide;
- tested compatibility matrix for major cloud clients, free clients and at least one fully local/offline model path;
- clear SAFE / WORKSTATION / FULL ACCESS explanation;
- security model, known limitations and troubleshooting;
- sponsor/donation links only after real accounts/URLs are configured.

Launch sequence:

1. **GitHub-first release** — tag/release, README, demo assets and documentation are the canonical landing point.
2. **Developer launch** — Show HN and relevant developer/MCP communities, focused on what is technically different rather than generic promotion.
3. **Self-hosted / automation launch** — communities interested in self-hosting, local AI, homelabs and workflow automation.
4. **Migration outreach** — content specifically for users of Desktop Commander and similar AI-computer tools.
5. **Broad launch** — Product Hunt plus LinkedIn/X and other public channels after real early-user feedback confirms onboarding works.
6. **Follow-up proof** — publish fixes, compatibility results, benchmarks/recovery demonstrations and user examples instead of treating launch day as the end.

Success should be measured by real adoption signals, not post impressions alone:

- successful installs;
- time-to-first-successful task;
- GitHub stars/watchers/forks as secondary signals;
- issues/discussions from real users;
- repeat usage;
- number of tested client/model combinations;
- recovery/uncertainty incidents correctly handled;
- sponsor/donation conversion only as an optional sustainability metric.

GUI/desktop interaction remains a later independent workstream.

## Release gates

RBridge 2.0.0 is not complete until:

- SAFE is still the default;
- MCP works without enabling unrestricted shell;
- WORKSTATION cannot silently escalate to FULL ACCESS;
- FULL ACCESS requires explicit opt-in;
- exact-commit CI is green;
- security negative tests are green;
- public-source scrub is green;
- documentation clearly distinguishes implemented vs optional capabilities;
- at least one major cloud client, one free client and one local/offline model path are acceptance-tested.
- installer/upgrade path is acceptance-tested on a clean machine or VM;
- launch demos use the same public release artifacts users receive;
- no high-visibility launch occurs before live acceptance is PASS.

## Non-goals

RBridge 2.x should not become:

- an unrestricted root shell by default;
- a hidden remote-access agent;
- a product tied to one AI vendor;
- a product tied to one orchestrator;
- a paywalled version of SAFE features;
- a system that retries uncertain side effects blindly.

The core invariant remains:

> **More capability must be explicit, auditable, and opt-in; it must not weaken SAFE mode.**
