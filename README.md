# RBridge

RBridge is a fail-closed remote execution and application-testing gateway for AI-assisted development and automation.

It provides bounded, auditable application execution, file operations, durable process sessions, chunked transfer, health checks, and GitHub-issue request/result transport.

## Status

This repository is a source release candidate. A checkout does not grant host permissions or imply a live deployment.

## GitHub transport configuration

Deployments must explicitly provide:

    RBRIDGE_GITHUB_REPOSITORY=owner/repository
    RBRIDGE_GITHUB_AUTHOR=github-login

Requests from a different configured repository or author are rejected.

## Verification

Before publication run: npm ci --ignore-scripts, typecheck, full tests, lint, server build, git diff --check, and CI for the exact candidate commit.

See SECURITY.md and docs/KNOWN_ISSUES.md.
