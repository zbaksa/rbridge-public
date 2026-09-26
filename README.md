# RBridge

RBridge is being extracted as a standalone, universal AI execution and
application-testing gateway.  It is intended to become usable by COCWIN,
Windmill, ChatGPT-compatible MCP clients and local AI systems.

## Current status

`PUBLICATION_BLOCKED_PENDING_SCRUB`

The repository is source-only.  No RBridge service is active, no controller
permission is granted, and the existing frozen COCWIN Remote Bridge remains the
only live remote path.  Initial source identity:

- live bridge release: `38491cf9f3deb22b3fafd1f995fa6d37e42cb49a` / tree `5a5f0ca18cef2ea839a26a3889b4d386e4436032`;
- COCWIN main reference: `8ca7c3372b82cbe0172c302fdf1644d8a5269fa6` / tree `9bd9ca4aab36ebadd52db3e6ce4fa511b1f6567e`;
- governing policy: `COCWIN 024 Standard od 23092026.md` / SHA-256 `5bc1d3539ef0be5a3a1efc096c3c9ba127b8a884e03fbf762e67bb5c4b4f1cfa`.

The first code change after extraction must add a regression test for missing
FILE targets: a missing file must become terminal `BLOCKED`, not remain queued.
