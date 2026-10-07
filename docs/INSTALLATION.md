# Installation

RBridge is currently **Linux/systemd-first**. This document describes the supported shape of a production-style deployment; exact usernames, groups, paths and controller integration remain deployment choices.

For a P2A upgrade of an existing service, follow the [approved installation design](superpowers/specs/2026-10-05-p2a-installation-design.md) and [implementation plan](superpowers/plans/2026-10-06-p2a-installation-native.md). The account creation and first-service setup examples below are for a new deployment. They do not authorize an existing service switch.

## 1. Runtime requirements

Required for the base GitHub transport:

- Linux
- Node.js 22.x
- npm for build/install
- GitHub CLI at `/usr/bin/gh` or an equivalent deployment that matches the adapter
- a dedicated non-root runtime user
- GitHub credentials for that runtime user
- writable durable state directory
- a request/result GitHub repository

Optional/additional dependencies:

- `APP_RUN`: compatible controller broker
- Windmill (optional): no RBridge-side Windmill daemon is required; use Windmill to create and monitor normal GitHub request Issues
- built-in `node-safe` and `stdin-echo` process profiles currently expect the runtime Node binary path encoded in the source profile; inspect `src/domain/remoteBridgeHostProfiles.ts` on your release before enabling PROCESS.

## 2. Build an exact source revision

```bash
git clone https://github.com/zbaksa/rbridge-public.git
cd rbridge-public
git checkout <release-or-exact-sha>

npm ci --ignore-scripts
npm run verify
```

Do not deploy a dirty checkout as if it were the verified commit.

## 3. Create a dedicated runtime account

Example only — adapt account-management policy to your host:

```bash
sudo useradd --create-home --shell /bin/bash rbridge
```

RBridge itself verifies that:

- the process is not UID 0;
- the actual username equals `RBRIDGE_RUNTIME_USER`;
- the runtime home is an absolute non-root path.

## 4. Prepare a release directory

The shipped systemd template expects an immutable-style current-release layout:

```text
/usr/local/libexec/rbridge/releases/<sha>/
/usr/local/libexec/rbridge/current -> releases/<sha>
```

Stage the complete final material under a new, unused release name. Copying only `dist` and `package.json` is incomplete: the running entry points also need their exact locked production dependencies.

The P2A runtime manifest inventories `dist`, `node_modules`, `package.json` and `package-lock.json`. The separate toolkit manifest also includes its reviewed `ops` and contract files and the locked MCP client dependency needed by its readers. Build and install dependencies as a non-root account before protecting the material. Root must not run npm, compile a checkout or import runtime-owned installation modules.

Bind every final name, byte, mode and confined link to a manifest; copy into a create-only protected stage; verify the entire published tree again. Release files must be root-owned and non-writable by the runtime account. An existing release, unexpected file, escaping link or changed ancestor blocks publication rather than being overwritten. Staging leaves `current` and the running service unchanged.

## 5. Prepare durable state

The default runtime derives state from the dedicated user's home:

```text
/home/rbridge/.local/state/rbridge
```

Prepare it with restrictive permissions:

```bash
sudo install -d -o rbridge -g rbridge -m 0700 \
  /home/rbridge/.local/state/rbridge
```

Subdirectories are created for request state, process sessions and transfers.

## 6. Authenticate GitHub as the runtime user

The GitHub Issue adapter executes `gh` as the RBridge process user.

Authenticate that identity:

```bash
sudo -u rbridge -H gh auth login
sudo -u rbridge -H gh auth status
```

Use a GitHub identity with only the permissions needed for the configured control repository.

RBridge needs to list Issues, read Issue bodies/comments, add result comments and close completed Issues.

## 7. Runtime environment file

Create a root-owned environment file, for example `/etc/rbridge/runtime.env`:

```text
RBRIDGE_RUNTIME_USER=rbridge
RBRIDGE_RELEASE_SHA=<40-hex-git-sha>
RBRIDGE_GITHUB_REPOSITORY=owner/control-repository
RBRIDGE_GITHUB_AUTHOR=trusted-github-login
```

Protect it:

```bash
sudo chown root:root /etc/rbridge/runtime.env
sudo chmod 0600 /etc/rbridge/runtime.env
```

See [Configuration](CONFIGURATION.md) for the complete deployment reference.

## 8. systemd

The repository ships `ops/systemd/rbridge.service.in` as a deployment template.

Render these placeholders:

- `@RBRIDGE_USER@`
- `@RBRIDGE_GROUP@`
- `@CONTROLLER_GROUP@`
- `@RBRIDGE_HOME@`
- `@RBRIDGE_ENV_FILE@`
- `@RBRIDGE_STATE_ROOT@`

The template currently uses the project's AI Tool Fabric Node runtime path in `ExecStart`. If your deployment does not provide that exact runtime, render/maintain a site-specific unit that invokes your verified Node 22 binary and the same `remoteBridgeMain.js` entry point.

Do not casually remove the hardening directives. The template includes:

- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=read-only`
- explicit `ReadWritePaths`
- `PrivateTmp=yes`
- `PrivateDevices=yes`
- empty capability bounding/ambient sets
- `UMask=0077`

After rendering:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rbridge.service
sudo systemctl status rbridge.service
```

## 9. Acceptance check

Use a HEALTH request from [Quick Start](QUICKSTART.md).

Verify:

- the service is active/running;
- the returned result matches the V2 result contract documented for the deployed release;
- HEALTH status is PASS;
- the release SHA equals the deployed revision;
- the request Issue is closed only after result publication.

Then test only the capabilities you actually intend to expose.

## Upgrade rule

Treat each gate as separate evidence:

| Gate | Required observation | What it establishes |
| --- | --- | --- |
| Source | Exact commit/tree and complete non-root CI logs | Source tests and checks passed on that revision |
| Final artifacts | Complete runtime/toolkit manifests and actual owner, IPC, MCP and helper fixture receipts on the profile's exact Node binary | The final material executes in its qualified isolated fixture |
| Readers | Every registered reader's full case inputs, verdicts, archive/adoption evidence and exact closure | Actual reader qualification; a reference parser PASS is insufficient |
| Privileged fixtures | Isolated Root copy, crash/ledger, configuration CAS, fake-unit stop, helper-family and bootstrap observations | Privileged mechanics were exercised without changing production |
| Root imports/bootstrap | Protected interpreter/stdlib/shared-library closure and exact reviewed, authenticated bootstrap bytes | The command's execution provenance is qualified |
| Maintained pause | Fresh lock, unchanged service identity, settled writers/helpers, full snapshot and all five correlated gates | The current stopped state is eligible for the authorized transaction |
| Installed acceptance | Fresh invocation, HEALTH and FILE_READ receipts, actual readers, controlled same-candidate restart and original-ID replay | The installed candidate is accepted |

The Native installation branch remains under development. Its qualification assessment always reports `BLOCKED` and cannot render an owner command. The physical collector, reviewed command dispatch and complete host qualification are still required. A source test, artifact hash, scope label or caller-supplied PASS cannot grant Root readiness.

The archive collector's Source implementation preserves the original request body, fixed authenticated query preimages and two complete comment inventories, including an explicit empty final page. Changes to content, identity, timestamps or comment count block the capture. It does not qualify result semantics or actual workflow adoption: those still require the named installed reader, and the physical Root capture remains a separate qualification step.

The installed-reader collector's Source implementation uses genuine private artifact/archive observations and a fixed protected non-root CLI. It resumes the isolated artifact owner, verifies its original terminal receipts and keeps it available while two bounded read-only SDK clients exercise legacy and modern negotiation. It submits no new operation. Finalized reader metadata can reuse earlier observations only after every other profile field and the original observation are reverified. Workflow adoption and MCP fixture provenance remain explicit separate gates; this collector cannot issue the complete installation bundle or a service action.

The fixed Core fixture producer separately resumes that isolated owner and uses its actual journal and publisher with a local carrier port. It preserves original HEALTH/FILE receipts, produces bounded missing-file and invalid-argument READ outcomes and a large READ carrier, and checks expired closed replay, fresh expired admission and identity collision. Digest and author negatives derive from those original publication bytes. Expected reader verdicts are assembled independently from Core and publication preimages. Root may retain the full protected invocation as a private producer observation; a local carrier never becomes an authenticated GitHub archive or workflow adoption. Actual privileged producer execution is a separate qualification gate.

The fixed MCP fixture producer reads the original HEALTH/FILE operations through the actual locked SDK in both legacy and modern negotiation modes. It compares every capability, status and output page with the original operation preimages, preserves full SDK frames and derives expected verdicts without calling the reader being qualified. The protected Root reader collector accepts these cases only through the private MCP observation tied to the exact original artifact observation; equal metadata from another artifact cannot substitute it. Both modes use SDK package version 2.3.0. Source fixture bytes, actual protected producer execution and workflow adoption remain separate evidence classes.

The fixed copy/ledger fixture producer copies tiny known material through the actual descriptor copier, checks confined links, rejects collisions and unmanifested objects, and rejects a same-length byte change after publication. Two owned children receive permission to write only after the parent holds their pidfds; they die before replacement of a pending START ledger record and after durable START acknowledgement. Full ledger and pending-record bytes remain available for comparison. Its protected Root collector creates a private generated directory below Root's home, verifies actual runtime UID1027 before chown/copy, retains all fixture evidence and issues only a private two-case observation. Configuration CAS, fake-unit stop, helper-family and bootstrap observations are still separate required cases; these two components cannot complete privileged qualification or authorize a service action.

The configuration CAS producer uses the actual owned-configuration, pointer and ledger routines inside fixed isolated scenarios with a fake service. It preserves both original environment files, the CPU drop-in and hardening rows, refuses a pre-existing binding, preserves concurrent original-file edits and refuses restoration after START_ATTEMPTED. Complete original/overlay/ledger bytes, modes and refusal outcomes are compared against fixed expectations. Its separate protected Root collector verifies actual runtime UID1027, assigns that identity only to isolated state, retains protected evidence and issues a private configuration-component observation. It performs no actual systemd action and supplies no fake-unit-stop, helper-family, bootstrap or complete bundle authority. Source data cannot register that Root origin; boolean values cannot substitute numeric UID/GID fields.

The helper-family component reuses the genuine original artifact launch rather than starting another process. It requires the complete fixed runuser, runtime owner and SDK child roster, exact executable and argument pins, numeric kernel identities, nonce readiness, original input/output bytes and observed settlement. Its protected Root collector accepts only the original artifact observation object, retains the full case in a generated private directory and rechecks the immutable closure before verifying it again. Equal serialized metadata cannot replace that object. Pure Source comparisons use explicitly synthetic census data and cannot establish actual kernel origin, fake-unit-stop qualification or complete installation authority.

The fake-unit stop producer uses one generated test unit and a fixed non-root worker from the protected toolkit. It creates an exclusive runtime unit link, checks the loaded program before starting it and performs no global daemon reload. The worker pins its allocated directory by device/inode, writes readiness and SIGTERM receipts through a retained directory descriptor and has a fixed 30-second manager lifetime. A successful case requires the original worker identity, an early graceful shutdown receipt, settled pidfd, two empty cgroup observations and an unchanged production service/pointer fingerprint. A zero stop-command exit alone is insufficient. All fixture evidence remains available. Source unit/kernel observations are synthetic data; actual protected systemd execution is still a separate unperformed qualification gate, and the collector cannot issue the full installation bundle.

The bootstrap publication fixture preserves authenticated original script bytes, exercises the standalone create-only copier, verifies mode400 readback and a collision without replacement, then rejects a same-length change in its isolated copy. Its protected Root collector requires the same original authenticated bootstrap observation object and an exact match with the immutable toolkit entry before importing the byte copier. It retains the full originals and damaged fixture for review. Source publication mechanics, actual protected Root observation, bootstrap execution and complete installation authority remain separate: this fixture executes no copied payload and cannot render an owner command.

The privileged component collector joins the six fixed cases only after verifying every actual private origin and both original artifact/authenticated-bootstrap objects. It retains complete component reports and raw case inputs/outputs in a separate private generated directory, then reobserves them before issuing its own private component-set token. It retains an immutable tuple of the original object references as well as their complete metadata digests; an equal-byte replacement cannot transfer authority. Reader-only profile extensions require rechecking the original set and the target's immutable closure. Its pure Source comparison remains data, and even a genuine six-case token grants no payload execution, external workflow adoption, reviewed owner command or production service permission.

The reader-adoption collector requires the same genuine installed-reader invocation object, actual Core/MCP case origins and an authenticated owner receipt naming the exact registry, profile, reader report and fixture set. Two full read-only captures must show the unchanged original Issue; the fixed tool-version probe and both complete query preimages are retained. The receipt explicitly adopts the named readers for P2A acceptance and declares the deployment's consumer inventory. This is an authenticated owner declaration, separate from independently discovering unindexed clients or observing an external workflow run. Source data comparisons cannot authenticate that declaration, and the component grants no installation or service permission.

The copied-bootstrap execution collector uses a fresh protected copy of the exact authenticated toolkit entry, separate from the deliberately damaged publication fixture. Its fixed internal qualification mode checks Root identity, isolation flags, the actual kernel namespace and the copy's complete bytes before emitting readiness or consuming input. It executes only the freshly verified protected entry bytes, validates every toolkit import before loading the package, and retains the full Python manifest, import/mapping observation, original input/output/readiness and settled owned-process facts. The closure permits the copied file only as `__main__`, with protected ancestors and a byte-for-byte match to the pinned immutable toolkit bootstrap. This is a read-only execution probe; even its genuine private origin cannot install, dispatch a transaction or authorize a service action. Source and synthetic capture comparisons remain data, and the real Root fixture is separately required.

The qualification material collector joins the authenticated Source CI, original final-artifact, original named reader and owner adoption, six privileged cases, authenticated bootstrap and copied-entry observations. Its immutable snapshot retains eight original references and the seven nested privileged references; the reader must use the identical artifact object. Complete evidence, manifest, canary and helper bytes are retained and every producer is reobserved before registration and owner review. A later import or mapping within a freshly verified immutable Python closure preserves the complete historical observation while every other pin and preimage must still match. After our own production switch, provenance preservation checks the original private references, protected retained evidence and current immutable material without repeating the fixture's pre-switch production fingerprint. Material collection and historical preservation grant no installation authority; authenticated owner review and the private bundle issuer remain separate boundaries.

The material-review collector requires the genuine original qualification material and two identical authenticated owner Issue captures. The preparation receipt names all seventeen pins, including the complete material digest, Source run/job/log, runtime/toolkit manifests, readers, helper, canary, Python closure and authenticated bootstrap. Every full capture and query preimage is retained. Metadata-equivalent material objects cannot replace the original, and historical preservation rechecks retained provenance without repeating the pre-switch fixture baseline. A pure comparison is data only; even authenticated preparation review grants no production switch permission or reviewed owner command.

The Source CI collector independently reads the fixed repository's exact workflow run, job, commit tree and complete raw job log through the protected authenticated tool. It requires the reviewed workflow, dedicated runner, completed successful steps and actual Node22/Python/TypeScript verdicts. Serialized CI evidence remains data; this observation grants no physical artifact, reader adoption, privileged fixture or service permission.

Once a complete reviewed bundle exists, preparation remains separate from explicit switch authorization. Before changing configuration or the pointer, the transaction records intent, maintains exclusion, independently verifies its protected backup and checks the stopped durable state. Original environment files, drop-ins, unrelated settings and the original pointer are preserved by ownership and compare-and-swap checks.

After `START_ATTEMPTED`, an acceptance failure requires stopping and preserving the candidate's durable state and evidence. Automatically returning to the old pointer or restoring the old backup is unavailable. Before any start attempt, restoration of only the transaction's exact owned configuration/pointer additions still requires fresh compatible gates and observed ownership. See the recovery and exit meanings in [Operations](OPERATIONS.md).

See [Operations](OPERATIONS.md).
