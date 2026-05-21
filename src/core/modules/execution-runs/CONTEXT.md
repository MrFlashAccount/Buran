# Execution-runs core context

Canonical source of execution-run rules.

Responsibilities:

- expose lifecycle constants, schema version, gate/status names, transition metadata, and event types;
- validate transitions and terminal-state rules;
- build transition/non-transition events;
- apply pure transition updates to snapshots;
- define execution-run entity/value objects and registry repository port.

Compatibility:

- `src/execution-runs/constants.js` and `src/execution-runs/state-machine.js` are deprecated re-exports only;
- runtime/application/storage/recovery code imports this core context directly.

Non-goals:

- no persistence or filesystem storage;
- no concrete integrations;
- no application/composition imports.
