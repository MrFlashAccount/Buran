# SCM handoff core context

Canonical public language is provider-neutral: `ScmHandoffTarget`, `handoff_target`, `projection_ledger.handoff_target`, and `ScmHandoffPort`.

Responsibilities:

- validate and sanitize durable handoff target data;
- merge handoff projection events into local snapshots;
- define the handoff port consumed by application orchestration;
- provide a no-network local journal adapter for manual-review handoff flows.

Durable-data rule:

- legacy durable provider-profile fields may be read internally for persisted-data continuity;
- provider-specific transport, validation, and remote-write behavior lives under concrete integration modules.

Non-goals:

- no live provider writes in core;
- no schema migration of existing durable fields;
- no application/composition/integration imports.
