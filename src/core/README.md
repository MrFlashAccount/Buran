# Core architecture

`src/core` owns provider-neutral domain modules: entities, value objects, ports, constants, state machines, and pure services.

Dependency rule:

- core modules may depend on `src/shared` and other core modules only;
- application use-cases orchestrate core ports/services;
- integrations implement core ports and live outside core;
- composition wires concrete integrations into application use-cases.

Canonical modules:

- `modules/execution-runs` is the execution lifecycle authority;
- `modules/scm-handoff` owns provider-neutral handoff contracts and the no-network local adapter;
- GitHub-specific vocabulary/transport belongs in `src/integrations/scm/github/` or explicit deprecated compatibility wrappers only.
