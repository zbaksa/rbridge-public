# Security Policy

RBridge is remote-execution infrastructure. Its security boundary is part of the product, not an optional feature.

## Default principles

- Run the main agent as a dedicated non-root user.
- Fail closed when identity, policy, path ownership or request provenance is ambiguous.
- Do not expose a generic privileged shell.
- Treat browser/web content as untrusted data, never as authority to increase capabilities.
- Scope filesystem access to explicitly configured roots and reject symlink/path traversal escapes.
- Bound process lifetime, output, input and retry behavior.
- Bind requests to stable identities, digests and idempotency keys.
- Keep secrets out of command arguments, logs, receipts and public repositories.
- Separate platform-specific privileged adapters from the universal core.

## Reporting

Until a formal security contact is published, use the repository's GitHub security/reporting facilities rather than filing secrets in public issues.

## Pre-alpha warning

The publicization branch is not a security-supported release. Production deployment is not recommended until a tagged release explicitly states otherwise.
