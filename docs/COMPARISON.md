# RBridge compared

RBridge overlaps with remote shells, MCP computer-control servers and automation runners, but its design center is different.

This page compares **architecture and trust model**, not raw feature count.

## Executive summary

Choose **RBridge** when the important question is:

> How can an autonomous/scheduled system do bounded work on a host with durable identity, replay protection and explicit uncertainty semantics?

Choose **Desktop Commander** when the important question is:

> How can a trusted AI chat/client directly use my computer's files, terminal and processes through MCP?

Choose **SSH** when the important question is:

> How can a trusted human/admin securely log in or execute commands remotely?

Choose a **generic MCP server** when the important question is:

> How can I expose domain-specific tools/resources/prompts to MCP-compatible AI hosts?

## Comparison table

| Dimension | RBridge | Desktop Commander | SSH | Generic MCP server |
|---|---|---|---|---|
| Primary interface | Structured remote-execution contract | MCP tools | Remote login/command channel | MCP |
| Typical caller | Automation/agent/workflow | Interactive AI client | Human/admin/script | AI host |
| Generic terminal execution | No generic shell in the V2 PROCESS model | Yes, terminal control is a core capability | Yes | Depends on server |
| File access model | Source-controlled roots + path/symlink/secret checks | File tools with configurable restrictions | Whatever remote account can access | Depends on server |
| Process model | Source-controlled profiles + durable sessions | Interactive/background process tools | Shell/process via session | Depends on server |
| Durable request journal | Core behavior | Product has activity/session features, but not RBridge's requestId/digest journal contract | No | Implementation-specific |
| Replay/collision semantics | Explicit | Tool/product-specific | No workflow-level replay model | Implementation-specific |
| Uncertainty state | Explicit UNKNOWN/UNCERTAIN handling | Tool error semantics | Exit/transport status | Implementation-specific |
| Async internet control without inbound host port | GitHub Issues | Remote Desktop Commander uses hosted Remote MCP + paired device | Usually requires reachable SSH path/VPN/tunnel | Depends on transport |
| MCP-native | No | Yes | No | Yes |
| GUI/document tooling | No dedicated GUI/document product layer | Rich file/document/desktop-oriented tools | No | Depends |
| Multi-platform product focus | Linux/systemd today | macOS/Windows/Linux | Broad | Depends |
| Best for | Controlled autonomous execution | Human-in-the-loop AI computer use | Administration | App/tool integration |

## Desktop Commander

Desktop Commander is an MCP server/product focused on giving AI clients terminal, filesystem and process-management capabilities.

Its official project describes terminal control, file operations and process management through MCP. Its remote mode uses a hosted Remote MCP service plus a local paired device agent; commands execute on the user's machine.

Its security documentation is also unusually clear: Desktop Commander states that it is a privileged local automation tool, assumes the connected AI client is trusted, and says its restrictions are guardrails rather than a sandbox capable of containing a malicious/compromised client.

That is not a criticism; it is a different trust model.

### RBridge difference

RBridge does not accept a general process executable or arbitrary shell command in its V2 PROCESS contract. The release defines allowed process profiles. It also persists request identity/digest and uses explicit replay/collision/uncertainty semantics.

Desktop Commander is therefore generally more convenient for broad interactive AI-assisted computer work; RBridge is intentionally narrower for automation where deterministic boundaries and durable history matter more than interactive flexibility.

## SSH

OpenSSH is a secure remote login and command-execution transport. The `ssh` client can log into a remote system or execute a supplied command, with encrypted communications and port forwarding.

SSH is mature and excellent for trusted administration.

### RBridge difference

RBridge is not primarily a secure byte channel or login protocol. It sits at a higher application layer:

- strict request schema;
- configured remote request identity;
- operation TTL;
- source-controlled profiles;
- durable request state;
- replay/collision behavior;
- structured result/evidence.

In many architectures, SSH and RBridge can coexist: SSH for administrators, RBridge for automation.

## Generic MCP servers

MCP is an open standard for connecting AI applications to tools, resources and prompts. A server may expose narrow business tools or broad system actions.

RBridge is not MCP-native today.

### RBridge difference

RBridge's execution/durability model could sit **behind** a future MCP adapter. An MCP tool call would then become an ingress transport while RBridge preserved its internal request identity, source profiles and durable execution semantics.

That is on the roadmap rather than claimed as a current feature.

## Windmill

Windmill is complementary to RBridge rather than a direct replacement.

Windmill is a workflow/orchestration platform with scripts, flows, schedules, webhooks, resources/secrets and monitoring. In the recommended public architecture, Windmill creates and monitors normal RBridge GitHub requests while RBridge remains the host-side bounded execution boundary.

That separation is useful:

- Windmill decides **when and in what workflow** work should happen;
- RBridge decides **what the remote host will accept and how execution is durably recorded**.

See [Windmill integration](WINDMILL.md).

## CI runners / job agents

CI runners are another adjacent category. They are excellent at executing declared repository pipelines.

RBridge differs by accepting individually authenticated, bounded operations against a long-lived host state and by exposing durable FILE/PROCESS/CHUNK/HEALTH primitives rather than only repository pipeline jobs.

## Which should I use?

### Use RBridge if:

- remote work is produced by autonomous/scheduled agents;
- duplicate side effects are a serious concern;
- you need explicit replay/collision handling;
- you want no generic shell in the remote request model;
- process and file capabilities should be release policy;
- auditability and "unknown means unknown" matter.

### Use Desktop Commander if:

- a person is actively chatting with a trusted AI;
- broad terminal/filesystem access is desired;
- MCP compatibility is a priority;
- document/data/desktop convenience matters more than a narrow execution contract.

### Use SSH if:

- the remote actor is a trusted administrator/operator;
- interactive shell access is desired;
- you need tunneling/port forwarding;
- you do not need an application-level durable request journal.

### Use an MCP server if:

- you need standard AI tool discovery/calling;
- your capability maps naturally to specific application tools/resources;
- the server's own security/durability model meets your needs.

## Sources / further reading

Desktop Commander:

- https://github.com/wonderwhy-er/DesktopCommanderMCP
- https://github.com/desktop-commander/remote-desktop-commander
- https://github.com/wonderwhy-er/DesktopCommanderMCP/security

Model Context Protocol:

- https://modelcontextprotocol.io/
- https://ts.sdk.modelcontextprotocol.io/v2/

OpenSSH:

- https://man.openbsd.org/ssh

Comparison reflects public documentation available in October 2026. Product capabilities can change; verify upstream documentation when making a security decision.
