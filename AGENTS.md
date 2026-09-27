# AGENTS.md — RBridge

## Working rules

- Treat repository source, tests and public documentation as the canonical development surface.
- Work in isolated branches/worktrees.
- Preserve fail-closed behavior, least privilege and explicit identity boundaries.
- Never weaken path, repository, author, app, process or request validation for convenience.
- Never add a generic shell or request-controlled executable path.
- Keep durable request identity and replay/collision protection intact.
- Use regression-first changes for bug fixes: reproduce, patch minimally, then run targeted and full verification.
- Keep source verification, CI, publication and live deployment evidence separate.
- Do not claim PASS without fresh evidence for the exact candidate being described.

## Required verification

For a release candidate run typecheck, targeted tests for touched behavior, the full test suite, lint, server build and git diff --check.

Security-sensitive changes also require negative tests proving unauthorized repository, author, app, path and process inputs remain rejected.
