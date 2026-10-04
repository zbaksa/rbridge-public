# Contributing to RBridge

Thank you for helping improve RBridge.

Because RBridge is privileged-adjacent software, changes are reviewed not only for functionality but also for **capability expansion, replay semantics and fail-closed behavior**.

## Development setup

Requirements:

- Node.js 22.x
- npm
- Git

```bash
git clone https://github.com/zbaksa/rbridge-public.git
cd rbridge-public
npm ci --ignore-scripts
npm run verify
```

## Branches

Work in an isolated branch.

Keep each pull request focused. Security-sensitive behavior is easier to review when protocol, policy and unrelated refactors are not mixed.

## Required verification

Before opening a PR:

```bash
npm test
npm run typecheck
npm run lint
npm run build:server
git diff --check
```

Or run:

```bash
npm run verify
```

CI also runs the public-source scrub.

## Regression-first bug fixes

For bugs:

1. add/reproduce a failing test;
2. make the smallest safe fix;
3. run targeted tests;
4. run full verification;
5. document behavior changes when public.

## Security-sensitive changes

Changes to any of these areas need extra scrutiny:

- request schemas;
- repository/author identity;
- file roots/path validation;
- process profiles/executable selection;
- durable request state;
- replay/collision handling;
- uncertainty semantics;
- controller broker;
- FlowPilot authentication/callback validation;
- systemd hardening.

Include negative tests proving denied inputs remain denied.

## Do not

Do not:

- add a generic request-controlled shell;
- allow request-controlled executable paths;
- accept arbitrary filesystem roots from a request;
- weaken unknown-field rejection just for convenience;
- convert uncertain execution into automatic success/failure;
- delete replay/collision checks to fix a test;
- add private IPs, credentials, private repository names, tokens or host-specific secrets to public source/docs.

## Public-source scrub

CI rejects common private leakage patterns in public source/docs.

If the scrub fails, use deployment configuration or public-safe placeholders. Do not obfuscate sensitive values to evade the check.

## Documentation

User-visible behavior changes should update the relevant files under `docs/`.

If a wire contract changes, update:

- `docs/PROTOCOL.md`
- tests
- changelog

If a deployment requirement changes, update:

- `docs/CONFIGURATION.md`
- `docs/INSTALLATION.md`
- systemd guidance if relevant.

## Commit/PR guidance

Good PR descriptions include:

- problem;
- security/capability impact;
- exact behavior before/after;
- tests;
- known limitations.

## Security reports

Do not open a public Issue containing exploitable vulnerability details or real credentials. Follow [SECURITY.md](SECURITY.md).
