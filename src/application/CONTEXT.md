# Application context

Owns thin use-case orchestration only.

Rules:

- import lifecycle constants/state-machine authority from `src/core/modules/execution-runs`;
- depend on core ports/contracts and injected adapters, not concrete provider integrations;
- sequence registry, workspace, gate, implementation, and SCM handoff flows;
- keep durable schema rules in core/schema modules and storage details in integrations.

SCM handoff:

- application receives an `scmHandoffAdapter` through composition/injection;
- local runtime wires the no-network local journal adapter by default;
- live GitHub behavior remains an explicit integration/profile choice, never the CLI default.
