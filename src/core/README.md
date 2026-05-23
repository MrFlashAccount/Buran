# Core architecture

`src/core` owns provider-neutral domain modules: entities, value objects, ports, constants, state machines, and pure services. Cross-module/application seam ports may live in `src/core/ports` when there is no honest domain module behind them.

Dependency rule:

- core modules may depend on `src/shared` and other core modules only;
- application use-cases orchestrate core ports/services;
- integrations implement core ports and live outside core;
- composition wires concrete integrations into application use-cases;
- `src/core/modules/<module>` must contain real domain substance (entity, value object, policy, or service), not only a `ports/` folder.

Canonical modules:

- `modules/execution-runs` is the execution lifecycle authority;
- `modules/workspace-leases` owns workspace lease request/status contracts, entities, policy decisions, and service/record-store ports;
- `modules/scm-handoff` owns provider-neutral handoff contracts, projection/status/error authority, and services;
- `ports/integration.js` owns metadata validation/default helpers; concrete integrations import it, never the reverse;
- `ports/workspace-preparation-inspector.js` owns the workspace-preparation inspector seam without pretending there is a workspace domain module;
- provider-specific vocabulary/transport belongs under the matching `src/integrations/` subtree.
