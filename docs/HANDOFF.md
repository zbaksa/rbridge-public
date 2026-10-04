# RBridge maintainer handoff

## Repository role

This repository is the public RBridge source of truth for code, tests, deployment templates and public documentation.

A checkout does not imply an active deployment or host authorization.

## Current product contract

- GitHub repository and allowed GitHub author are deployment configuration, not compiled identities.
- V2 parsing fails closed against configured transport identity and exact request schemas.
- FILE, PROCESS, CHUNK, HEALTH and APP_RUN capabilities are bounded by source-controlled/runtime contracts.
- Durable request identity, replay and collision protection are preserved across restart.
- Process executable selection is source-controlled, not request-controlled.
- Windmill is the recommended public orchestrator and uses the standard GitHub request/result transport.
- Deployment-specific secrets/private host details do not belong in public source or documentation.

## Maintainer rule

Do not describe a feature as supported merely because a test helper or internal module exists. Public capability claims should map to reachable product behavior and current source.

## Verification

A public candidate is eligible for merge only after:

1. dependency installation from the lockfile;
2. targeted tests for changed behavior;
3. full tests;
4. typecheck;
5. lint;
6. server build;
7. public-source scrub;
8. `git diff --check`;
9. CI tied to the exact candidate commit.

Live deployment acceptance is separate from source/CI acceptance.

## Documentation map

- `README.md` — product landing page
- `docs/QUICKSTART.md` — first request
- `docs/INSTALLATION.md` — deployment
- `docs/ARCHITECTURE.md` — component model
- `docs/SECURITY_MODEL.md` — trust/security
- `docs/PROTOCOL.md` — public wire contract
- `docs/CONFIGURATION.md` — deployment configuration
- `docs/WINDMILL.md` — public workflow orchestration
- `docs/OPERATIONS.md` — operating procedures
- `docs/TROUBLESHOOTING.md` — failure diagnosis
- `docs/COMPARISON.md` — adjacent tools
- `docs/ROADMAP.md` — future direction

Update these when behavior changes.
