# Security Policy

RBridge is a privileged-adjacent execution gateway. Deploy it with least privilege and review the full [security model](docs/SECURITY_MODEL.md) before enabling write/process/application execution.

## Core security properties

The public implementation includes:

- explicit trusted GitHub repository and author configuration;
- exact request schemas and bounded TTLs;
- app-scoped/controller execution identities;
- bounded input and output;
- source-controlled file roots and process profiles;
- no request-controlled process executable paths;
- durable request identity, replay and collision handling;
- fail-closed handling of ambiguous or unauthorized operations;
- explicit UNKNOWN/UNCERTAIN semantics where execution cannot be proven;
- no generic root shell;
- optional loopback-only authenticated FlowPilot ingress;
- systemd hardening template;
- no deployment credentials or secret-bearing transport configuration committed to this repository.

## Supported public line

Security fixes are applied to the current `main` development/release line unless a GitHub release explicitly states a longer support window.

The project is pre-1.0, so deployment operators should track exact commit/release identity.

## Deployment responsibilities

Operators must protect:

- the trusted GitHub author account;
- GitHub CLI/token credentials on the host;
- runtime environment files;
- controller broker access;
- RBridge durable state;
- the runtime OS account;
- any writable filesystem roots.

A checkout alone does not grant host permissions.

## Reporting a vulnerability

Please **do not open a public Issue with exploit details, credentials, private hostnames, tokens, or sensitive reproduction data**.

Until a dedicated public disclosure mailbox/process is published, contact the repository owner privately through an available GitHub/private channel and provide:

- affected commit/release;
- impacted component;
- reproduction steps with secrets removed;
- expected vs actual security boundary;
- whether exploitation may cause remote code/process/file access.

If immediate containment is needed, stop/disable the affected deployment, revoke relevant credentials, and preserve durable state/logs for analysis.

## Secret handling

Never commit:

- GitHub tokens;
- private keys;
- bearer/callback tokens;
- host-specific credentials;
- private infrastructure addresses/names that should not be public;
- production environment files.

Use deployment configuration and secret storage appropriate to your environment.

## Scope note

RBridge reduces remote-request capability compared with a generic shell, but it is not a VM/container sandbox. OS-level hardening and least privilege remain part of the security boundary.
