# Execution-runs core context

Canonical source of execution-run rules.

Responsibilities:

- expose lifecycle constants, schema version, gate/status names, transition metadata, and event types;
- validate transitions and terminal-state rules;
- build transition/non-transition events;
- apply pure transition updates to snapshots;
- define execution-run entity/value objects and registry repository port.

Canonical import rule:

- runtime/application/storage/recovery code imports this core context directly.

Non-goals:

- no persistence or filesystem storage;
- no concrete integrations;
- no application/composition imports.
