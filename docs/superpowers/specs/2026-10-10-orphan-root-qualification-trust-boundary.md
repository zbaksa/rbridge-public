# P2A orphan Root qualification — evidence custody and trust boundary

**Status: ARCHITECTURE DESIGN ONLY.** This document does not authorize Root execution, journal repair, helper admission, qualification replay, or a production switch. Prepared 2026-10-10.

## 1. Exact problem and evidence classification

One original orphan helper journal has only `intent.json` and an unlocked `journal.lock`; it is missing `running.json` and `settled.json`. Historical command was a pinned read-only `systemctl show rbridge.service`, but the journal never captured its original PID or session. The historical execution and outcome are **UNKNOWN**, not PASS and not proof that the process never ran. Preserve original journal contents and all inode/time provenance indefinitely.

The source-only Stage2D draft is PR #44, hardened head `e9ffb8411c8ac3c9a0807b71863f0cbad6d918a1`. Stage2E is draft PR #45, `83b16836d3f17281e568ff56561846e20bf70cc8`. These commits have successful dedicated source CI; a nonroot staging toolkit is separately verified. None of this constitutes actual Root publication, Root evidence, owner authentication, qualification, or acceptance.

## 2. Existing guard contracts — neither may be bypassed implicitly

1. `helper_journal.inspect_helper_journal` requires the original complete four-record journal. The orphan must continue to fail `HELPER_JOURNAL_UNSETTLED` on cold scans.
2. `helper_journal.begin_root_helper` holds the protected maintenance-parent lock and inspects every cold helper before launching anything. Its existing `_current_root_helper` exception applies only to a verified live producer with a RUNNING journal and cannot match the orphan.
3. `maintenance_registry.assert_no_unfinished_transactions` independently inspects the same helper journal and rejects the incomplete record.
4. `owned_process.run_owned_process` goes through `begin_root_helper` before any subprocess launch.

A stored disposition or matching JSON request cannot restore qualification. A future live one-workflow exception, if justified, must be reviewed against **both** independently enforced guard paths. Old binaries and cold/default readers remain fail-closed. No general ignore-orphan toggle, external allowlist, environment flag or monkey patch is acceptable.

## 3. Custody gap in current Stage2D source

The protected Root writer `orphan_root_disposition_store._record` stores the SHA-256 of `disposition_preimage`, not its canonical payload. The preimage itself stores hashes of the original observation, owner claim, direct-TTY attendance and kernel-census summaries. No corresponding canonical input bytes are durably stored by this inspected writer.

A later independent examiner with only the Root artifact therefore cannot recompute its underlying preimage/evidence chain. This is an **evidence-retention limitation**, not a finding that SHA-256 is insecure or proof of a runtime exploit.

Before any Root evidence writer is approved, select and test one of two explicit custody designs:

- **Single sealed record:** store complete, bounded canonical source evidence alongside its digest and original Root/journal identity; require create-once, readback, verified protected ancestry, fsync and no write-on-existing.
- **Content-addressed bundle:** write exact immutable source preimages and evidence as individually protected files with bounded sizes, fsync/readback and a separate commit record that verifies every digest. Crash before commit remains UNKNOWN, never settled or silently cleaned up.

Do not make an inaccessible or missing preimage appear verified. Preserve old evidence and forbid auto-delete/overwrite of partial records. Check the current size limit rather than assuming the expanded payload fits.

Source pathname `toolkit-<sha>` alone is not cryptographic Root code provenance: require separately validated release/source manifest and physically protected bytes. A foreground TTY ACK proves attended local terminal input, NOT an authenticated human owner. Until a separately designed owner-authentication trust root exists, `owner_authenticated=false` remains mandatory.

## 4. Future process-local one-workflow capability — not implemented

Only a later protected release may introduce an **opaque nonserializable in-memory Root capability**, and only after the following all pass:

- Immutable protected source, exact source tree and toolkit manifest verification, pinned profile and qualification driver SHA.
- Root real/effective UID and GID, host namespaces, protected code ancestry and direct foreground terminal in the *same* execution context.
- Explicit independent authenticated owner challenge for one exact qualification workflow, not a generic policy approval, not mere TTY presence.
- Original orphan byte/descriptor/boot binding under appropriate locks, original historical outcome kept UNKNOWN, no forged RUNNING/SETTLED.
- Full retained Root disposition evidence is physically reread and independently rehashed.
- Fresh complete bounded two-sample kernel census in the authorizing process. Unknown/unreadable/racing identities and active matching processes refuse. Recheck immediately before protected admission.
- No other unfinished peer transaction; no authorization for service stop/start/restart, cutover, or rollback.

Capability identity must bind issuing Root PID **and start ticks**, boot, monotonic expiration, original journal directory/intent/lock identity, protected toolkit SHA, authenticated owner challenge, exact qualification driver/profile, and a **fixed bounded helper step set**. Multiple helper steps in one qualification may be legitimate; implementation must explicitly define exact ordered use/consumption semantics and what happens on interruption. No unrelated worker, child, different PID, old boot, stale TTL, serialized JSON/nonce, persisted receipt or ambient callback may recreate or transfer it.

The operative guard paths must verify the **same current live capability** while protected identities and locks are held. They may recognize exactly one original orphan as unresolved-but-reviewed for this one workflow only. They must not return SETTLED or hide the orphan from ordinary readers. A failure consumes/invalidates the capability and permanently preserves uncertain evidence for independent review.

## 5. Failure-closed state machine (design)

```text
BLOCKED (default)
  -> PROTECTED_SOURCE_AND_EVIDENCE_VERIFIED
  -> OWNER_AUTHENTICATED_FOR_EXACT_QUALIFICATION
  -> FRESH_ROOT_KERNEL_AND_ORIGINAL_JOURNAL_VERIFIED
  -> EPHEMERAL_ONE_WORKFLOW_CAPABILITY
  -> QUALIFICATION_ONLY_ATTEMPT
  -> INDEPENDENT_ACCEPTANCE_AND_CUSTODY_SEAL
  -> SEPARATE_OWNER_PRODUCTION_DECISION
```

Every arrow requires fresh evidence and explicit acceptance; ambiguity, changed filesystem identities, timeout, dropped process, partial write or stale proof returns to BLOCKED with evidence retained. CI PASS or a disposition record can never jump directly to Root helper launch or production.

## 6. Mandatory negative test and evidence matrix

| Boundary | Must be refused |
| --- | --- |
| Original journal | Wrong SHA, argv, executable, input, boot, inode/mode, missing/extra member, fake PID, held lock, changed original record, other unfinished peer |
| Human identity | TTY-only ACK, forged receipt, stale/reused owner challenge, wrong qualified purpose, missing authenticated-owner trust root |
| Source/custody | Writable/symlink source, wrong source digest, partial create-once file, retained digest without matching bytes, wrong protected ancestor, failed fsync/readback |
| Kernel/process | Live or unreadable process, unknown executable, PID reuse, changed boot, start_ticks mismatch, probe race, expired observation |
| Capability | JSON/serialized token, foreign PID/thread/child, expired lease, unlisted helper step, double-consumed step, concurrent worker, different driver |
| Guard integration | One guard skips orphan while another rejects, cold scanner allows orphan, old binary reinterprets evidence, generic ignore switch |
| Production | Any start/stop/restart/cutover from disposition or qualification-only lease, unsealed or forged custody outcome |

Source tests, CI, isolated nonroot staging, direct Root provenance verification, Root owner identity and live privileged qualification are **independent** gates. A test count cannot replace physical release qualification or a production readiness claim.

## 7. Current decision and forbidden shortcuts

No deleting, renaming, relocating, quarantining or rewriting the orphan; no fabricated running/settled records; no failed-R4 replay; no Root privileged retry, no bypassing the maintenance registry, no service action, no production switch.

**SOURCE CI: PASS for named commits.**  
**NONROOT STAGING: PASS for named manifest.**  
**ROOT DISPOSITION CUSTODY: NOT PROVEN.**  
**AUTHENTICATED OWNER: NOT PROVEN.**  
**EPHEMERAL ROOT LEASE: NOT IMPLEMENTED.**  
**PRIVILEGED QUALIFICATION: BLOCKED.**  
**PRODUCTION: UNCHANGED.**

This document is review material only. A distinct protected implementation PR, negative test gate, new code/publication attestation and a separate attended Root qualification are necessary before operational action.
