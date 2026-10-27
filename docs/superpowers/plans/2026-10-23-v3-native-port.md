# Existing V3 Native Port Implementation Plan

> For agentic workers: use superpowers:executing-plans inline, task by task.

Goal: receive and return existing V3 effects through the Native Port link.

Architecture: extend the existing link and reuse V3 validators. Fence each
asynchronous operation to the exact port and negotiation epoch; serialize only
validation/admission, not the duration of browser work.

Tech Stack: existing TypeScript, Node22 app qualification, native synthetic tests.

Spec: docs/superpowers/specs/2026-10-23-v3-native-port-design.md

## Global Constraints

- Existing V3 wire schemas and full correlation/receipt validators only.
- No changes to serviceWorkerEntry, stored authority, credentials or deployment.
- V3 needs minor>=1, all V3 capabilities and a configured effect handler.
- Maximum128 retained V3 validations; negotiated message ceiling is4096..65536.
- Current V1 mutation and downgrade guards remain enforced.

## Review Focus

- Missing minor/capability/handler cannot invoke the effect callback.
- Invalid digest/correlation/receipt cannot invoke/post an effect result.
- Old asynchronous work cannot act after disconnect/reconnect/new HELLO.
- Delayed hashing preserves command arrival order without waiting for browser work.
- Oversize input, caller mutation and queue exhaustion fail closed.

## Task1: existing Native Port V3 boundary

Files: modify src/extension/nativePortServiceWorker.ts and package.json;
create tests/w1-v3-native-port.ts.

Consumes: parseEffectResult, routeServerToNativeV3, snapshotNativeMessage,
V3_CAPABILITIES and the existing command/result types.
Produces: optional onServerEffectCommand hook and sendEffectResult(command,result).

- [x] Write tests covering every Review Focus condition plus V1 downgrade/mutation.
- [x] Run the new tests against the pinned base; observe behavioral RED.
- [x] Add the bounded V3 validation queue, negotiation epoch fences and result validation.
- [x] Run targeted GREEN and inspect the complete diff.
- [ ] Qualify the exact candidate under RBridge app UID/Node22 if the controller admits it.
- [x] Run fresh whole-change review; fix Important findings with RED→GREEN tests.
- [ ] Preserve tested source in an isolated draft branch; do not merge/activate without qualification.

Local mirror note: SOURCE_BASE.json identifies byte-pinned Git blobs, not a full
canonical checkout. Canonical app verification must identify tested Git SHA/tree.
