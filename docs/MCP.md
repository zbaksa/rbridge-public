# MCP SAFE foundation (P1)

The P1 source provides a reachable MCP stdio entrypoint, tool discovery, deployment-controlled identity binding and a strict adapter to the frozen P0 submission/receipt contract. **The shipped entrypoint has no execution core connected: submissions return BLOCKED.** P2 must connect the same durable core used by the GitHub transport before SAFE execution is supported over MCP.

## Reachable tools

| Tool | Behavior in the P1 entrypoint |
| --- | --- |
| `rbridge_capabilities` | Reports SAFE mode, the principal/target binding, supported contract kinds, and `executionAvailable: false`. |
| `rbridge_submit` | Validates `operationId` plus a normalized SAFE `operation`; supplies principal/target from the trusted binding; returns `RBRIDGE_MCP_CORE_NOT_CONFIGURED`. |

The adapter interface can pass submissions and cancellation signals to the shared core once that core is integrated. It keeps the operation ID unchanged across transports/retries, checks returned receipt scope and phase evidence, and reports UNCERTAIN on a core exception or unusable receipt. It never retries the core automatically. A cancellation signal does not mean a process stopped or previous effects were rolled back.

`supportedKinds` describes the frozen contract, not completed capability handlers. APP_RUN, arbitrary shell, request-controlled executable/module paths and request-controlled filesystem roots are excluded. The P1 entrypoint has no alternative executor and no network listener.

## Local stdio trust boundary

Run the server as a dedicated non-root OS user. The entrypoint requires matching non-root real/effective UIDs, verifies that the effective username equals `RBRIDGE_RUNTIME_USER` and maps that authenticated local process identity to explicitly configured `RBRIDGE_MCP_PRINCIPAL_ID` and `RBRIDGE_INSTANCE_ID`. IDs use the lowercase P0 identifier syntax.

The operator owns this configuration and the local client launch. Client display names, model names, tool arguments, MCP metadata and input responses do not grant authority or select principal/target. Stdio binding is a local OS-account boundary; it is not remote HTTP/OAuth authentication or an OS sandbox. Remote serving needs a separately qualified authentication path.

## Build and start

Use Node.js 22, install locked dependencies and build:

```bash
npm ci --ignore-scripts
npm run build:server
```

Configure the local MCP client's command as `node`, its argument as the absolute path to `dist/server/server/rbridgeMcpMain.js`, and these environment variables:

```text
RBRIDGE_RUNTIME_USER=<actual non-root runtime username>
RBRIDGE_MCP_PRINCIPAL_ID=<deployment-owned principal id>
RBRIDGE_INSTANCE_ID=<deployment-owned target id>
```

The client must keep stdin open while expecting responses. Stdout carries MCP messages only; sanitized startup/protocol diagnostics go to stderr. Stdin EOF closes the SDK transport. Missing configuration, root execution or a different runtime username fails before discovery.

## Qualification

The official server/client SDK dependencies are pinned to 2.3.0. The same server factory serves modern 2026-07-28 and legacy-era sessions. Automated tests use actual SDK clients to discover/call tools in both eras, reject authority injection and malformed inputs, preserve operation identity, forward cancellation and verify the real entrypoint's OS boundary.

These tests qualify protocol behavior, not specific ChatGPT/Claude/Cursor/VS Code releases. Application compatibility, side-effect execution, GitHub/MCP shared durability, packaging, remote authentication and live deployment remain later gates in [V2_PLAN.md](V2_PLAN.md). No V2 production promotion follows from P1 source acceptance.
