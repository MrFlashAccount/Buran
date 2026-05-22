# SCM handoff core context

Canonical public language is provider-neutral: `ScmHandoffTarget`, `handoff_target`, `projection_ledger.handoff_target`, and `ScmHandoffPort`.

Responsibilities:

- validate and sanitize durable handoff target data;
- merge handoff projection events into local snapshots;
- define the handoff port consumed by application orchestration;
- define provider-neutral planning/result services used by concrete adapters.

Durable-data rule:

- legacy durable provider-profile fields may be read internally for persisted-data continuity;
- provider-specific transport, validation, remote-write behavior, and no-network local journal adapters live under concrete integration modules such as `src/integrations/scm/local-journal/`.

Non-goals:

- no live provider writes in core;
- no schema migration of existing durable fields;
- no application/composition/integration imports.
