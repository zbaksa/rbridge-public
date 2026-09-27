# RBridge public handoff

## Repository role

This tree contains the standalone RBridge source, tests and public provenance metadata. A checkout does not imply an active deployment or host authorization.

## Public-candidate contract

- GitHub repository and allowed GitHub author are runtime configuration, not compiled identities.
- V1 and V2 parsing remains fail-closed against the configured transport identity.
- FILE, PROCESS, CHUNK, HEALTH and APP_RUN capabilities remain bounded by source-controlled contracts.
- Durable request state, replay handling and collision protection are preserved.
- Deployment-specific host details and internal operational metadata are excluded from public documentation.

## Verification

A candidate is eligible for publication only after dependency installation from the lockfile, typecheck, targeted tests, full tests, lint, server build, public scrub scan, git diff --check and CI tied to the exact candidate commit.

Live deployment acceptance is separate from source and CI acceptance.
