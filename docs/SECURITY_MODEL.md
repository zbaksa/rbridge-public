# Security model

RBridge is a **privileged-adjacent automation gateway**. It should be treated like any service that can read/write files, start processes, or invoke application runners on a real host.

Its security model is built around **constraining what a remote request may describe**, **recording durable identity before/reliably around side effects**, and **failing closed when execution certainty is lost**.

## Security goals

RBridge aims to provide these properties:

1. only explicitly configured remote identities are accepted;
2. requests must match exact schemas and freshness limits;
3. remote requests cannot provide arbitrary process executable paths;
4. filesystem access is bounded by source-controlled roots and path checks;
5. binary content is integrity-checked;
6. request identity is durable and replay/collision aware;
7. uncertain execution is not silently retried as if nothing happened;
8. optional low-latency ingress is loopback-only and token-authenticated;
9. the service can run as a dedicated non-root systemd identity with hardening.

## Security non-goals

RBridge is **not**:

- a virtualization boundary;
- a container sandbox;
- a malware-analysis sandbox;
- a substitute for OS permissions, SELinux/AppArmor, VM isolation, or network policy;
- a generic policy engine for arbitrary shell commands;
- protection against an attacker who already controls the runtime account and can modify trusted deployment files.

The safest deployment combines RBridge's application-level boundaries with a minimally privileged OS account and host isolation appropriate to the risk.

## Identity boundary

### GitHub transport

A deployment must explicitly configure:

- `RBRIDGE_GITHUB_REPOSITORY`
- `RBRIDGE_GITHUB_AUTHOR`

The adapter filters requests to that repository/author, and the V2 parser verifies them again.

This means a compromised trusted GitHub account is a real security event: an attacker could submit any operation that the deployment itself allows.

Recommended controls:

- dedicated control repository;
- MFA/passkeys on the trusted GitHub account;
- least-privilege GitHub credentials on the host;
- no shared automation identity unless necessary;
- review repository collaborators and tokens regularly.

## Request freshness and shape

V2 limits include:

- exact top-level fields;
- request body at most 65,536 bytes;
- canonical ISO timestamps;
- TTL at most 30 minutes;
- at most 2 minutes future clock skew;
- exact operation-specific fields;
- bounded args, timeout and output limits.

Unknown fields are generally rejected instead of ignored.

This prevents a client from smuggling accidental capabilities through a loosely parsed request.

## Filesystem boundary

Current public source controls FILE access through `remoteBridgeHostProfiles.ts`.

The default allowed root is:

```text
/mnt/data
```

The file adapter additionally:

- requires canonical absolute lexical paths;
- rejects paths outside allowed roots;
- verifies the configured root is not a symlink;
- rejects symlinks encountered along an accessed path;
- blocks common secret paths/names such as `.ssh`, `.gnupg`, cloud credential directories, `.env`, `.npmrc`, credential/secret/token-like names;
- bounds read size and search traversal;
- uses atomic replacement for writes;
- validates SHA-256 for binary writes.

### Important limitation

The secret-name denylist is defense in depth, not a universal secret detector. Do not put sensitive data inside a writable RBridge root merely because its filename is not on the denylist.

## Process boundary

PROCESS START does not accept an executable path.

The request selects a source-controlled `profileId`. The current profiles are deliberately narrow:

- `git-read` — fixed Git executable and accepted read-only argument shape;
- `node-safe` — fixed Node executable and `--version`;
- `stdin-echo` — fixed Node program with bounded UTF-8 stdin.

Each profile defines:

- executable;
- fixed/validated args;
- allowed cwd roots;
- maximum lifetime;
- maximum output;
- stdin mode and limit;
- bounded force-kill timing.

A future deployment may add profiles, but doing so is security-sensitive source code.

## Durable request identity

RBridge computes a deterministic digest of the normalized request.

Durable state distinguishes:

- **NEW** — request has not been claimed;
- **REPLAY** — same request identity/digest already exists;
- **COLLISION** — same requestId with different immutable request content.

The worker persists state so a process restart does not erase request history and accidentally re-execute a completed side effect.

## Uncertainty model

Remote execution systems face an important failure mode:

> The caller loses the acknowledgement after the target may already have executed.

Blind retry can duplicate a side effect.

RBridge therefore has explicit uncertain states/errors for operations where execution may have happened but cannot be proven. Those cases are not automatically converted into a simple FAIL that invites unsafe retry.

At the public result level, terminal status can include:

- `PASS`
- `FAIL`
- `BLOCKED`
- `UNKNOWN`

`UNKNOWN` means the system intentionally refuses to invent certainty.

## Transfer integrity

CHUNK operations include:

- per-chunk SHA-256;
- full-object SHA-256;
- exact chunk count;
- expiration;
- bounded sizes;
- replay/collision checks;
- durable manifests.

A FINALIZE succeeds only after all chunks are present and the reconstructed object digest matches.

## Windmill orchestration

Windmill is an upstream orchestrator, not an additional trusted inbound RBridge port in the recommended public setup.

A Windmill flow creates a standard GitHub Issue request using the same repository/author identity that RBridge already validates. RBridge then executes and publishes the same structured result it would for any other client.

Security consequences:

- keep the GitHub token in a Windmill secret/resource;
- use the least GitHub permissions required for the RBridge control repository;
- the token identity must match the configured trusted RBridge author;
- a compromised Windmill workspace with access to that token can request any capability the RBridge deployment itself allows;
- Windmill does not bypass RBridge path/process/TTL/replay policy.

This preserves one public authorization boundary instead of introducing a second network control plane.

## systemd hardening

The supplied template uses:

- dedicated `User`/`Group`;
- `NoNewPrivileges=yes`;
- `ProtectSystem=strict`;
- `ProtectHome=read-only`;
- explicit writable state path;
- `PrivateTmp=yes`;
- `PrivateDevices=yes`;
- kernel/control-group protections;
- no ambient or bounding capabilities;
- `UMask=0077`.

Review hardening after rendering; do not delete restrictions merely to make an operation pass.

## State protection

Durable state is security-sensitive.

Recommended:

- runtime-owned, mode 0700 directories;
- files mode 0600;
- no shared write access;
- regular backup if request history matters;
- do not edit live store files by hand;
- stop the service before any offline migration/repair.

Corrupt or structurally unexpected records are intentionally treated as errors.

## Threat scenarios

### Prompt injection in an AI client

RBridge does not attempt to decide whether a request was "really intended" by a human. Its protection is capability containment: even a trusted author can only describe operations accepted by RBridge's configured/source policy.

For higher-risk deployments, put a human approval/policy layer before request publication.

### Compromised GitHub token on the RBridge host

A stolen host token may expose the control repository and result publication authority. Scope credentials narrowly and revoke them immediately.

### Compromised trusted GitHub author

This is more serious: the attacker can issue valid requests within RBridge's enabled capability set. Keep that capability set narrow and the runtime OS account minimally privileged.

### Malicious file contents

RBridge does not execute arbitrary file contents through FILE operations. However, downstream tools or APP_RUN jobs may. Treat content passed to other interpreters separately.

### Local attacker

RBridge is not intended to protect a host from an attacker who already has equal or greater local privileges than the runtime user.

## Reporting vulnerabilities

See the repository-level [SECURITY.md](../SECURITY.md). Do not publish secrets, proof-of-concept credentials, or exploitable host details in a public Issue.
