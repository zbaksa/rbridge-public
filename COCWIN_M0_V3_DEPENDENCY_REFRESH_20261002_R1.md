# RBridge M0 v3 dependency refresh — 2026-10-02 R1

This isolated candidate preserves the qualified Native transport source at b7be8600f20f9b34dc27eb8f4effe2ec4e6524f5 and updates existing dependency versions. It is not a runtime deployment or completion of Task 8.

## Actual dependency evidence

App-owned preflight: cocwin-private issue 12882, UID/GID 1027, baseline full verification 218/218. Baseline audit: issue 12883, two moderate and one high package-level findings. No vulnerability reproduction was run.

The app-owned lock generator ran npm audit fix --package-lock-only --ignore-scripts without --force in issue 12884. Its output was truncated, so that response was not accepted as complete qualification and the mutation was not repeated. Read-only diagnosis in issue 12885 identified exactly four version changes and npm property reordering. Issue 12887 validated every unchanged package semantically and restored baseline property order without changing lock semantics.

| Package | Before | Candidate |
| --- | --- | --- |
| fastify (direct) | 5.12.3 | 5.12.5 |
| brace-expansion | 5.0.9 | 5.0.12 |
| fast-uri | 4.1.4 | 4.2.1 |
| ajv nested fast-uri | 3.1.7 | 3.1.8 |

Only version, resolved tarball and integrity fields changed in those four entries; the root dependency pin is updated. No packages were added or removed and lockfile version remains 3. The package diff is 14 inserted and 14 removed lines. The Fastify security release is 5.12.5; brace-expansion fixes are included in 5.0.12; both selected fast-uri versions meet the reviewed advisory's fixed version thresholds. This audit is a package-advisory check, not a statement of complete security or demonstrated runtime exposure.

Official sources: https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc ; https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr ; https://github.com/advisories/GHSA-hrr3-gc8f-f4qj .

Generation readback at 2026-10-02T12:04:46.260Z: npm audit returned 0 and reported zero vulnerabilities. package.json SHA-256 25706c70faf34908ea9c1fe630711a392e2c536510aeeae4e5531f38f3b83850; package-lock.json SHA-256 21099426a018baac400f85080bc619e9b87f5031d2fd8779430a3256971b5a62. Independently reconstructed scratch files matched both app-generated hashes before this source commit.

## Qualification gates

At this source commit, fresh install, full app verification, exact Linux/Windows CI and whole-branch review are NOT_RUN. They must qualify this exact source before integration. Evidence belongs to the candidate that actually ran. The previously qualified Native transport donor and canonical RBridge checkout are preserved. COCWIN's owner-approved R3 deployment remains pinned to 2a15b13880b280e491f75c686e8e1363fb4a0d88 and is not modified by this candidate.
