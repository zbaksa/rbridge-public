# Security

RBridge is a privileged-adjacent execution gateway and should be deployed with least privilege.

Core security properties include:

- explicit trusted GitHub repository and author configuration;
- exact request schemas and bounded TTLs;
- app-scoped execution identities;
- bounded input and output;
- source-controlled file roots and process profiles;
- no request-controlled executable paths;
- durable request identity and replay handling;
- fail-closed handling of ambiguous or unauthorized operations;
- no generic root shell;
- no credentials or secret-bearing transport in this repository.

Do not commit deployment tokens, private keys, host-specific secrets, or private infrastructure details. Report suspected vulnerabilities privately to the repository owner until a dedicated disclosure channel is published.
