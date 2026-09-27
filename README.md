# RBridge

RBridge is a local-first, self-hosted execution and application-testing bridge for AI assistants, local models, CI systems, and orchestration platforms.

> **Status: pre-alpha / publicization branch.** The extracted compatibility runtime is being generalized and security-reviewed before source publication. Do not treat this branch as production-ready.

## Goals

- safe filesystem, process, Git and application execution;
- explicit capability/policy boundaries rather than unrestricted shell access;
- durable receipts, hashes and replay/idempotency protection;
- browser application testing with Playwright as a first-class capability;
- usable by ChatGPT, local AI and other clients through stable transports;
- first-party compatibility with COCWIN without making COCWIN a hard dependency.

## Architecture direction

```text
AI / agent / CI
      |
  transport
      |
  RBridge agent
      |
 policy + dispatcher + evidence
      |
 filesystem / process / git / browser / optional platform adapters
```

The public core and platform-specific adapters are intentionally separated. COCWIN compatibility is an adapter/profile, not the universal product identity.

## Current evidence

The private extraction baseline has passed its targeted test/build qualification, but the public branch is not yet source-complete. Public publication remains gated on scrub, generic configuration, CI and security review.

See `docs/ARCHITECTURE.md` and `SECURITY.md`.
