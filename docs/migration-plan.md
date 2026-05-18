# Migration Plan

The target is a new narrow plugin under `plugins/buran/`. Existing `plugins/background-worker` and `scripts/github-*queue` code are legacy/reference only during this package. Do not edit them as part of architecture package creation.

## Slice 0 — Architecture package

Deliver these docs only:

- `ARCHITECTURE.md`;
- `CONTEXT.md`;
- `docs/state-machine.md`;
- `docs/execution-run-schema.md`;
- `docs/github-projection-contract.md`;
- `docs/migration-plan.md`.

Exit criteria: docs state the selected direction, boundaries, schema/state/projection contracts, and migration slices.

## Slice 1 — Skeleton plugin boundary

Create the minimal plugin entrypoint and configuration shape without executing tasks.

Exit criteria:

- command/interface accepts an explicit approved packet list;
- no autonomous discovery;
- no remote writes;
- dry validation can report packet sufficiency.

Rollback: remove the new plugin skeleton; no remote state touched.

## Slice 2 — Local registry

Implement `ExecutionRun` persistence, atomic writes, `events.jsonl`, artifacts, and rebuildable indexes.

Exit criteria:

- create/read/update/recover a run locally;
- schema version enforced;
- interrupted write recovery covered;
- indexes rebuild from run folders.

Rollback: preserve registry folder for inspection; disable command path.

## Slice 3 — State machine and locks

Implement lifecycle transitions and workspace/repo/issue/branch/conflict-surface leases.

Exit criteria:

- weak packets become `blocked_plan_insufficient`;
- safe runs can acquire leases;
- conflicting runs block conservatively;
- 3–4 non-conflicting workspaces can run in parallel.

Rollback: release leases via recovery routine; keep event journal.

## Slice 4 — Implementation, verification, review loop

Wire approved-packet execution, verification gate, internal review gate, and scoped fix loop.

Exit criteria:

- execution stays inside approved packet envelope;
- verification artifacts are recorded;
- review artifacts are recorded;
- PR creation remains impossible unless both gates pass.

Rollback: leave branch/workspace for manual inspection; mark run blocked or failed locally.

## Slice 5 — GitHub/TaskFlow projection

Add idempotent projection adapter for comments/status/project fields and PR creation.

Exit criteria:

- local JSON remains authoritative;
- projection attempts/results are logged;
- missing/stale projections can be repaired;
- PR is created only after verification `PASS` and internal review `PASS`;
- terminal handoff is `Ready for Manual Review`.

Rollback: disable projector; use local state to audit or manually clean remote projections.

## Slice 6 — Legacy retirement checks

Compare remaining usage of legacy/reference queues and document anything still needed as an adapter or deleted path.

Exit criteria:

- no runtime dependency on legacy queue ownership;
- any copied behavior has a test and an explicit new owner;
- old paths are either untouched reference, deprecated, or removed in a separate approved cleanup.

Rollback: revert only the cleanup slice; the new plugin remains local-state authoritative.

## Migration risks

- Remote projection drift: mitigate with idempotency keys and repair from local JSON.
- Over-parallel execution conflicts: mitigate with conservative conflict-surface locks.
- Weak packet quality: mitigate by blocking as `blocked_plan_insufficient`.
- Hidden dependency on legacy queues: mitigate by keeping migration slices small and reviewable.
- Gate bypass pressure: enforce PR creation checks in the application workflow and projector.
