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

## WorkerTask ownership

This core context owns `WorkerTask`, worker task statuses, completion decisions, task identity, and legal decision semantics. Core may evaluate duplicate, late, conflict, unknown, unauthorized, rejected, deferred, and accepted completions without importing application, concrete storage, adapters, shell, UI, provider transports, tracker transports, messaging transports, or worker-provider integrations.

## WorkerTask lifecycle note

Issue #16 adds durable implementation/fix worker lifecycle tracking. Core owns WorkerTask and CompletionDecision semantics; application code sequences lifecycle writes; JSON registry persists and replays them; observability/reporting must expose only sanitized worker summaries and safe artifact refs.
