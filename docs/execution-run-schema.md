# ExecutionRun Schema Contract

The local registry is the canonical state owner. Remote systems are projections derived from these files.

Implementation ownership is explicit:

- `src/execution-run-schema.js` owns current `execution-run.v2` snapshot, batch, lease-record builders/validators, typed artifact/gate event validators, artifact-ref traversal, and version rejection policy.
- `src/registry-store.js` owns registry domain write ordering for run snapshots, events, artifacts, indexes, and run lease snapshot/event updates.
- `src/registry.js` remains a compatibility export surface for existing callers; new domain mutations should route through the store seam.

## Layout

```text
registry/
  batches/
    <batch_id>/
      batch.json
  runs/
    <run_id>/
      run.json
      events.jsonl
      artifacts/
        packet.md
        implementation-log.md
        verification.json
        internal-review/
          <hash>.json
        pr.json
        projection-log.jsonl
  indexes/
    active-runs.json
    workspace-leases.json
  leases/
    <sha256(lock-key)>.json
```

The exact root path is implementation-configurable, but this shape is the architectural contract.

## `batch.json`

`batch.json` is the immutable intake snapshot for one explicit packet list. It stores batch-level metadata only; raw packet data remains in per-run packet artifacts.

Required fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version string. |
| `batch_id` | Stable id for the intake batch. |
| `created_at` | Batch intake timestamp. |
| `source` | Source kind and packet-list path/reference. |
| `input_summary` | Packet count, task ids, and packet hashes. |
| `selected` | Count and run ids selected from the packet list. |
| `accepted` | Count and run ids queued for later stages. |
| `blocked` | Count and run ids blocked by packet insufficiency. |
| `config` | Slice-relevant local-only config and disabled side effects. |

## `run.json`

`run.json` is the current snapshot for one ExecutionRun.

Required fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version string. Required in every persisted file/event. |
| `run_id` | Stable unique run id. |
| `task_id` | Local task identifier from the approved packet/batch. |
| `github` | Repo, issue number, intended branch, and PR metadata when created. |
| `packet` | Packet hash, source path/reference, approval metadata, and sufficiency status. |
| `state` | Current state from `docs/state-machine.md`. |
| `last_sequence` | Last fully applied event sequence reflected by the snapshot. |
| `execution.current_epoch` | Monotonic execution/gate epoch. New verification epochs reset gate heads. |
| `workspace` | Workspace id/path and lease status. |
| `locks` | Repo/issue/branch/conflict-surface lease keys. |
| `gates.verification` | Current verification gate head: status, epoch, attempt, refs, actor, and idempotency summary. |
| `gates.internal_review` | Current internal-review gate head: status, epoch, attempt, refs, actor, and idempotency summary. |
| `artifacts.recorded.by_path` | Immutable recorded-artifact heads keyed by relative artifact path, with epoch/attempt provenance. |
| `artifacts` | Named artifact references and recorded-artifact content hashes. |
| `projections` | Last known GitHub/TaskFlow/comment/project projection results. |
| `created_at` / `updated_at` | Timestamps. |
| `terminal_reason` | Required for terminal blocked/failed states. |

## `events.jsonl`

Append-only event journal. One JSON object per line.

Required fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Event schema version. |
| `run_id` | Owning run. |
| `sequence` | Monotonic integer per run. |
| `timestamp` | Event time. |
| `type` | Transition, artifact, gate, lock, projection, or recovery event name. |
| `state_before` / `state_after` | Present for transition events. |
| `actor` | Human/operator or adapter/module that produced the event. |
| `evidence` | Artifact refs, hashes, command summaries, or remote ids. |
| `idempotency_key` | Required for projection/effect events. |

Recovery only accepts documented event types. Current accepted types are `transition`, `artifact.recorded`, `gate.result_recorded`, `lock.lease_acquired`, `lock.lease_released`, `lock.lease_blocked`, `projection.intent_recorded`, `projection.result_recorded`, `recovery.lease_stale_reclaimed`, and `recovery.lease_record_removed`. Unknown event types are quarantined even when they include timestamp/actor/evidence fields.

`artifact.recorded` evidence is typed and must include: safe relative `path`, `sha256`, `bytes`, `gate_name`, `execution_epoch`, `gate_attempt`, `recorded_from_state`, `recorded_at`, `actor`, and `provenance`.

`gate.result_recorded` evidence is typed and must include: `gate_name`, `execution_epoch`, `gate_attempt`, `recorded_from_state`, `status`, `artifact_refs`, `recorded_at`, `actor`, and `idempotency_key`.

## Lease records

`leases/<sha256(lock-key)>.json` is a local lock-file record for one acquired surface. Lock files are created with exclusive local filesystem writes and are rebuildable from valid run snapshots plus recovery. They are not global process locks and have no remote side effects.

Required lease fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version string. |
| `lease_id` | Lease id shared by all surface records for one run acquisition. |
| `run_id` / `task_id` | Owning run/task. |
| `status` | `acquired` for active lease records. |
| `surface` | `workspace`, `repo_checkout`, `issue`, `branch`, or `conflict_surface`. |
| `key` / `value` | Canonical lock key and human-readable value. |
| `workspace_id` / `workspace_path` | Reserved local workspace identity/path; no checkout is created by this slice. |
| `repo` / `issue_number` / `branch` / `conflict_surface` | Conflict metadata. |
| `acquired_at` / `expires_at` / `ttl_ms` | TTL metadata used by local recovery. |

Conflict detection is conservative across workspace id, repo checkout path, issue, branch, and declared conflict surfaces. `repo_checkout` is scoped to the reserved workspace path so 3–4 parallel workspaces can hold separate checkouts for the same repo when issue/branch/conflict-surface keys do not overlap.

## Artifacts

Artifacts are immutable once referenced by an event. If content changes, write a new artifact and append a new event.

Recorded verification/review artifacts are local-ledger entries. A path may be reused only when the stored hash already matches exactly; reuse with a different hash is rejected.

Minimum expected artifacts:

- `packet.md` — normalized approved packet copy or pointer with hash.
- `implementation-log.md` — compact implementation summary and touched files.
- `verification.json` — verification commands/checks, outcomes, and evidence.
- `internal-review/<hash>.json` — immutable local internal-review findings, sanitized packet review context, and final review status.
- `pr.json` — PR number/url/head/base/status after creation.
- `projection-log.jsonl` — remote projection attempts and results.

Verification and review command records describe allowed adapters/gates from the approved packet and Buran policy. They must not become a general-purpose arbitrary script execution surface.

## Registry store ordering

`src/registry-store.js` centralizes multi-file mutation order. Current `execution-run.v2` ordering is:

- Intake: write packet artifact, initialize event journal, append `packet_received`, write `run.json`, commit sufficiency transition, then rebuild indexes.
- Transition: append the transition event, write the matching snapshot, release terminal lease records when needed, then rebuild indexes for terminal transitions.
- Artifact record: write artifact content, append `artifact.recorded`, update `run.json` artifact head/`last_sequence`, then return.
- Gate result record: append `gate.result_recorded`, update `run.json` gate head/`last_sequence`, then return.
- Lease acquire/release/recovery: lease record writes/deletes are paired with lock/recovery events and snapshot updates through the store seam before indexes are rebuilt.
- Index files under `indexes/` are derived from valid run folders and are never authoritative.

## Atomic writes

- Low-level atomic helpers live behind the registry store/compatibility seam.
- Write snapshots/artifacts to a temporary file in the same directory.
- Flush file contents where practical.
- Rename temp file into place.
- Append journal events as complete JSONL records; incomplete trailing lines are ignored and quarantined during recovery.
- Update indexes only after the run-level write succeeds.
- Indexes are rebuildable from run folders and must not be the only copy of state.

## Recovery

Recovery order:

1. Load `run.json`.
2. Replay `events.jsonl` and verify monotonic sequence.
3. Verify each transition edge against `docs/state-machine.md`.
4. Semantically replay `artifact.recorded` and `gate.result_recorded` to rebuild gate/artifact heads.
5. Verify the replayed state/heads/`last_sequence` match the snapshot.
6. Verify referenced artifact hashes where present.
7. Rebuild active-run and workspace-lease indexes.
8. Reclaim expired lease records by marking the owning run lease as `stale_recovered`, appending `recovery.lease_stale_reclaimed`, deleting local lease records, and reporting the finding. Recovery only reclaims when TTL has elapsed; it does not guess active ownership.
9. Remove terminal/orphan lease records from the local lease-record directory.
10. Reconcile projections using idempotency keys in later projection slices.
11. Quarantine corrupt, malformed, incomplete, unknown-event, missing-artifact, hash-mismatch, conflicting-idempotency, stale/wrong-state gate, or other ambiguous run folders instead of guessing.

Slice 2 quarantine layout:

```text
registry/
  quarantine/
    <timestamp>_<run_id>_<reason>/
      run.json
      events.jsonl
      artifacts/
      quarantine-report.json
```

The local recovery command writes `indexes/recovery-report.json`, rebuilds indexes from valid runs, quarantines semantic ledger mismatches, and has no external side effects.

## Schema evolution

- Current version is exactly `execution-run.v2`.
- Readers reject unsupported schema versions explicitly.
- Persisted shape changes require synchronized updates to `src/execution-run-schema.js`, this document, and focused tests.
- Every schema change increments `schema_version`.
- Migrations must be explicit, idempotent, and recorded as recovery/migration events.
- No implementation may rely on undocumented fields.
- Registry and recovery remain local-only and do not emit external telemetry.
