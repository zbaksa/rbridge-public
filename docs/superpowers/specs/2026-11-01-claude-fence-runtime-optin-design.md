# Claude fence runtime opt-in design
The V11 parser and worker accept the bounded Claude JSON envelope only with an explicit option, but the process entrypoint currently never supplies that option. Complete that source interface without enabling it on any host.

Use RBRIDGE_ALLOW_CLAUDE_FENCE: absent or exact "0" disables; exact "1" enables; every other value fails startup with REMOTE_BRIDGE_CLAUDE_FENCE_CONFIG_INVALID. The explicit strings are this implementer's choice under the owner's instruction to proceed without questions. The existing source stack's default remains disabled.

A strict process-level switch is the smallest useful approach. Leaving the worker-only option would require another source edit at deployment; making the envelope unconditional would change the accepted input boundary for every installation. Neither is needed.

Resolve the option before constructing the worker. Keep mandatory root-owned HOLD initialization ahead of any work and preserve repository, author, digest, expiry and APP_RUN checks. No parser grammar change, dependency, deploy, service/environment mutation or COCWIN source change. Source success does not prove host authority, ROOT outcome or production readiness.

Verify the actual entrypoint with the real worker, durable store and parser; replace only external GitHub, fixed host HOLD loading and OS identity at test boundaries. Exercise off/on/invalid, raw JSON compatibility, forged author, and held APP_RUN. Run existing security suites and required verification. The fixture HOLD and identity are source evidence only.
