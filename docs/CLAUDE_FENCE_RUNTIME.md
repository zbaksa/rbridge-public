# Claude JSON envelope: explicit runtime opt-in

This source candidate exposes the existing worker option through
`RBRIDGE_ALLOW_CLAUDE_FENCE`. No installation is enabled by this change.

| Process value | Result |
|---|---|
| Absent | Disabled; existing pure JSON intake remains available |
| Exact `0` | Disabled |
| Exact `1` | Enable the existing bounded Claude JSON envelope |
| Any other value, including empty, whitespace or `true` | Startup fails with `REMOTE_BRIDGE_CLAUDE_FENCE_CONFIG_INVALID` |

The accepted envelope is unchanged: exactly one initial JSON block with the
known bounded provenance footer. Repository, author, expiry, operation,
duplicate-key and digest checks still apply. The flag is process configuration,
never a field the request sender can choose.

Mandatory pinned owner HOLD initialization still precedes intake. Framed
protected APP_RUN requests remain WAITING before controller submission. The
switch grants no ROOT authority and does not replace the separate worker's
per-script owner approval.

This is source preparation only. Before any separately qualified live activation,
prove the exact installed/loaded release, effective HOLD pin and policy, relevant
controller/Native fences, original-writer disposition and safe recovery. CI and
the source integration fixtures are not those host proofs. Leave the switch
absent until the deployment gates are satisfied; this change performs no deploy,
service restart or environment mutation.
