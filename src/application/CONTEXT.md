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

## WorkerTask sequencing

Application runners create worker tasks before implementation/fix dispatch, record dispatch intent evidence, ingest completion evidence, record durable `CompletionDecision`s, and only then request outer `ExecutionRun` transitions. Application code does not own lifecycle legality and must route canonical task state through execution-run core/schema plus the registry repository port.

## WorkerTask lifecycle note

Issue #16 adds durable implementation/fix worker lifecycle tracking. Core owns WorkerTask and CompletionDecision semantics; application code sequences lifecycle writes; JSON registry persists and replays them; observability/reporting must expose only sanitized worker summaries and safe artifact refs.
