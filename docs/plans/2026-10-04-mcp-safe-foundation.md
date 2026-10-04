# P1 MCP SAFE foundation

The approved V2 P0 contract remains authoritative. P1 adds a reachable stdio transport and a strict adapter; P2 connects the shared durable execution core and capability handlers. This patch does not promote V2 to production.

## Design

- Use pinned official MCP server/client SDK 2.3.0. One server factory serves modern 2026-07-28 and legacy-era clients.
- The stdio entrypoint verifies its non-root OS runtime user and requires deployment-controlled principal and target IDs. Client names, tool arguments and MCP metadata cannot choose identity or authority.
- Discover `rbridge_capabilities` and `rbridge_submit`. The submission envelope accepts only an operation ID and a frozen SAFE operation; the adapter supplies principal/target and calls the shared-core interface once.
- The shipped entrypoint has no execution core configured yet. Valid submissions return explicit BLOCKED. No fallback to legacy APP_RUN, generic shell, an arbitrary module path, or an in-memory execution engine is permitted.
- Bound JSON size/depth, reject unknown fields and unsafe operation kinds, preserve the caller's operation ID, and validate returned receipt scope. Core exceptions or unusable receipts return UNCERTAIN without automatic retry. Cancellation signals are evidence of a request, not proof that a process stopped.
- Stdio stdout contains MCP messages only. Configuration/protocol diagnostics use sanitized stderr JSON. No network listener is introduced.

## Implementation sequence

1. Add security and adapter tests first: identity mapping, strict schemas, normalized delegation, blocked unconfigured core, collision-sensitive identity preservation, uncertain core failure, and no retry.
2. Add SDK client tests for both eras using the real stdio entrypoint, including discovery, valid-but-blocked submission, unknown fields and unsupported APP_RUN.
3. Implement the minimal adapter, server factory and stdio entrypoint. Keep durable core integration explicitly pending P2.
4. Document the reachable behavior, local trust boundary, invocation, and qualification limits. Update development history.
5. Install from the lockfile and run targeted tests, full tests, typecheck, lint, build, public-source scrub and diff check. Review the final diff and require exact-candidate canonical CI before merge. Keep live acceptance separate.

## Acceptance boundaries

P1 acceptance proves the transport/adapter foundation, not side-effect execution, unified GitHub/MCP durability, remote HTTP authentication, application compatibility, network isolation or deployment. P2 and later release gates remain mandatory.
