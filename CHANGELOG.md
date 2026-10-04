# Changelog

RBridge is currently pre-1.0. This changelog records public-facing behavior and productization milestones.

## Unreleased

### Documentation / productization

- expanded README into a product overview and Quick Start;
- added installation, architecture, security, configuration and protocol guides;
- documented FlowPilot integration;
- added operations and troubleshooting guides;
- added comparison with Desktop Commander, SSH and MCP;
- added roadmap and contribution guidance;
- added issue templates.

## 2026-10-04 — FlowPilot parity / standalone cutover line

Public main includes:

- durable FlowPilot APP_PROBE support;
- COCWIN master-policy health action;
- COCWIN snapshot-refresh action;
- COCWIN continuous-qualification action;
- public-safe deployment-configured COCWIN endpoint derivation;
- action-specific callback evidence;
- exact-SHA CI coverage.

## Existing public V2 capability line

- GitHub Issue request/result transport;
- bounded APP_RUN, FILE, PROCESS, CHUNK and HEALTH operations;
- durable request identity/replay/collision handling;
- durable process sessions;
- chunk transfer integrity;
- hardened systemd deployment template;
- public-source scrub in CI.

Historical internal/deployment rollout artifacts are intentionally not treated as public product API.
