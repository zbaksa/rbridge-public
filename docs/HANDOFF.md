# RBridge extraction handoff

- Host: `aether-engine`
- APP_ID: `rbridge`
- Linux user/home: `rbridge` / `/home/rbridge`
- Source directory: `/home/rbridge/backend`
- Public repository: `zbaksa/rbridge-public`
- Public baseline: `5ca94ad6733bfda752c450ae821c6fa227303dcf` / `d3614467e3dfc21a2e9176d292d8a03a60daa442`
- Extraction branch: `extract/frozen-stage2-r2`
- Live bridge release: `38491cf9f3deb22b3fafd1f995fa6d37e42cb49a`
- COCWIN main baseline: `8ca7c3372b82cbe0172c302fdf1644d8a5269fa6`
- Policy SHA-256: `5bc1d3539ef0be5a3a1efc096c3c9ba127b8a884e03fbf762e67bb5c4b4f1cfa`
- Runtime: `DISABLED_SOURCE_ONLY`
- App execution route: `BLOCKED_NOT_YET_CONFIGURED`
- Publication: `BLOCKED_PENDING_SCRUB`
- Known upstream defect: missing FILE target can remain queued instead of
  becoming terminal BLOCKED; fix only through RED -> GREEN regression work.
