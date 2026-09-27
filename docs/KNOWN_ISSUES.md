# Known issues

## RB-001 — missing read-only FILE target remained pending

Status: **fixed in the source candidate; release/deployment acceptance is separate**.

Earlier Stage-2 behavior could leave a read-only FILE request pending when the file port raised a real `ENOENT`. The worker now normalizes `ENOENT` only for read-only operations (`LIST`, `STAT`, `READ`, `READ_MANY`, `SEARCH`) to `REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND` and publishes a durable terminal `BLOCKED` result.

Regression coverage verifies terminalization, durable replay after worker recreation, recovery after result-publication failure without re-executing the read, preservation of `APPEND_TEXT` creation behavior, no broadening to `MOVE` failures, and no misclassification of persistence-layer `ENOENT`.

The fix does not change write-operation classifications or deployment permissions.
