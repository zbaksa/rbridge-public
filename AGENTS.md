# AGENTS.md — RBridge

## Governing operating standard

Use `COCWIN 024 Standard od 23092026.md` (SHA-256 `5bc1d3539ef0be5a3a1efc096c3c9ba127b8a884e03fbf762e67bb5c4b4f1cfa`) together with current COCWIN
coordination.  Latest explicit owner instructions prevail where they conflict
with older project notes.

## Mandatory boundaries

- Remote access to `aether-engine` uses only the existing COCWIN Remote Bridge.
- Do not use SSH, Desktop Commander, or another gateway as fallback.
- Durable, recurring, or autonomous work belongs in COCWIN Automation Engine
  and Windmill; do not create ChatGPT Automations or a parallel scheduler.
- Keep the frozen live COCWIN Remote Bridge v1.00 and shared root helpers intact.
- Develop RBridge under Linux identity `rbridge` in isolated branches/worktrees.
- Distinguish APP_SOURCE_SHA, COCWIN_SOURCE_SHA, bridge release SHA and
  POLICY_SHA256.  Never substitute one for another.
- Never claim PASS without fresh corresponding test evidence.
- Public publication is blocked until private-path, secret, identity and
  COCWIN-specific reference review is complete.
