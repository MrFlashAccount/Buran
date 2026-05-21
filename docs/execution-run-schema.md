# ExecutionRun Registry Contract

The local registry is the canonical state owner. Remote systems are projections derived from registry state. Core code owns provider-neutral run, gate, artifact, lease, `work_item`, `scm_target`, `handoff_target`, and `projection_ledger` semantics; the concrete JSON/filesystem layout below is the current storage adapter contract, not a core dependency.

Implementation ownership is explicit:

- `src/execution-runs/schema/index.js` owns current `execution-run.v2` snapshot, batch, lease-record builders/validators, typed artifact/gate event validators, artifact-ref traversal, and version rejection policy.
- `src/integrations/storage/json-registry/store.js` owns registry domain write ordering for run snapshots, events, artifacts, indexes, and run lease snapshot/event updates.
- `src/execution-runs/registry/index.js` remains a compatibility export surface for existing callers; new domain mutations should route through the store seam.

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
        implementation-dispatch/
          intent-<hash>.json
          result-<hash>.json
        fix-loop/
          intent-<attempt>-<hash>.json
          result-<hash>.json
        verification.json
        internal-review/
          <hash>.json
        pr/
          projection-intent-<hash>.json
          projection-result-<hash>.json
  indexes/
    active-runs.json
    workspace-leases.json
  leases/
    <sha256(lock-key)>.json
```

The exact root path is implementation-configurable. This shape is the current JSON storage adapter contract; core behavior depends on the registry port, not on filesystem paths.

## `batch.json`

`batch.json` is the immutable intake snapshot for one explicit packet list. It stores batch-level metadata only; raw packet data remains in per-run packet artifacts.

Required fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version string. |
| `batch_id` | Stable id for the intake batch. |
| `created_at` | Batch intake timestamp. |
| `source` | Source kind and packet-list path/reference. |
| `input_summary` | Packet count, `work_item` ids, and packet hashes. |
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
| `task_id` | Legacy-compatible local identifier for the approved `work_item` from the packet/batch. |
| `work_item` | Provider-neutral approved work identity and summary. |
| `scm_target` | Provider-neutral repo/review target, branch, and conflict identity. |
| `github` | Current GitHub-profile compatibility view of repo, issue number, intended branch, and PR metadata when created or locally projected for handoff. Adapter-specific; not core/domain language. |
| `packet` | Packet hash, source path/reference, approval metadata, and sufficiency status. |
| `state` | Current state from `docs/state-machine.md`. |
| `last_sequence` | Last fully applied event sequence reflected by the snapshot. |
| `execution.current_epoch` | Monotonic execution/gate epoch. New verification epochs reset gate heads. |
| `workspace` | Workspace id/path and lease status. |
| `locks` | Repo checkout/`scm_target`/branch/conflict-surface lease keys. |
| `gates.verification` | Current verification gate head: status, epoch, attempt, refs, actor, and idempotency summary. |
| `gates.internal_review` | Current internal-review gate head: status, epoch, attempt, refs, actor, and idempotency summary. |
| `artifacts.recorded.by_path` | Immutable recorded-artifact heads keyed by relative artifact path, with epoch/attempt provenance. |
| `artifacts` | Named artifact references and recorded-artifact content hashes. |
| `projections` | Last known provider projection results, including local fake handoff metadata when no network write is allowed. Current GitHub/TaskFlow fields are adapter/profile compatibility views. |
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

`artifact.recorded` evidence is typed and must include: safe relative `path`, `sha256`, `bytes`, `gate_name`, `execution_epoch`, `gate_attempt`, `recorded_from_state`, `recorded_at`, `actor`, and `provenance`. Supported artifact stages include `workspace_preparation`, `implementation_dispatch`, `fix_attempt`, `verification`, and `internal_review`; `fix_attempt` artifacts are valid only from `fix_loop` and use current-epoch provenance.

`gate.result_recorded` evidence is typed and must include: `gate_name`, `execution_epoch`, `gate_attempt`, `recorded_from_state`, `status`, `artifact_refs`, `recorded_at`, `actor`, and `idempotency_key`.

## Lease records

`leases/<sha256(lock-key)>.json` is a local lock-file record for one acquired surface. Lock files are created with exclusive local filesystem writes and are rebuildable from valid run snapshots plus recovery. They are not global process locks and have no remote side effects.

Required lease fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version string. |
| `lease_id` | Lease id shared by all surface records for one run acquisition. |
| `run_id` / `task_id` | Owning run and legacy-compatible `work_item` id. |
| `status` | `acquired` for active lease records. |
| `surface` | `workspace`, `repo_checkout`, `scm_target`, `branch`, or `conflict_surface` (`issue` remains a current GitHub-profile compatibility surface). |
| `key` / `value` | Canonical lock key and human-readable value. |
| `workspace_id` / `workspace_path` | Reserved local workspace identity/path; no checkout is created by this slice. |
| `repo` / `scm_target` / `branch` / `conflict_surface` | Conflict metadata. `issue_number` is a current GitHub-profile compatibility field. |
| `acquired_at` / `expires_at` / `ttl_ms` | TTL metadata used by local recovery. |

Conflict detection is conservative across workspace id, repo checkout path, `scm_target`, branch, and declared conflict surfaces. `repo_checkout` is scoped to the reserved workspace path so 3–4 parallel workspaces can hold separate checkouts for the same repo when `scm_target`/branch/conflict-surface keys do not overlap.

## Artifacts

Artifacts are immutable once referenced by an event. If content changes, write a new artifact and append a new event.

Recorded verification/review artifacts are local-ledger entries. A path may be reused only when the stored hash already matches exactly; reuse with a different hash is rejected.

Minimum expected artifacts:

- `packet.md` — normalized approved packet copy or pointer with hash.
- `implementation-log.md` — compact implementation summary and touched files.
- `artifacts/implementation-dispatch/intent-<hash>.json` — immutable dispatch intent recorded before adapter execution. It includes `schema_version: implementation-dispatch-intent.v1`, `dispatch_status: dispatch_requested`, the run/`work_item` ids, `scm_target`/branch summary, workspace id, current execution epoch/state, packet artifact ref, workspace-preparation artifact ref, and `dispatch_intent_id` derived from the canonical intent payload.
- `artifacts/implementation-dispatch/result-<hash>.json` — immutable sanitized dispatch result recorded after adapter execution or reused on resume. Shape: `schema_version: implementation-dispatch-result.v1`, adapter/run/`work_item` ids, `dispatch_intent_id`, intent/packet/workspace-preparation artifact refs, timestamps, `status` (`COMPLETED`, `BLOCKED`, or `FAILED`), generic safe `summary`, `implementation_epoch`, sanitized `evidence`, optional sanitized `problem`, and actor. `COMPLETED` is accepted only when evidence includes changed-file evidence plus a durable implementation/result reference such as `implementation_result_id`, `commit_sha`, `patch_sha`, or implementation artifact ref(s). Raw prompt/stdout/stderr/output/transcript/session/content-like blobs are not valid evidence and must not be persisted through summary/problem/report fields.
- `artifacts/fix-loop/intent-<attempt>-<hash>.json` — immutable fix-attempt dispatch intent recorded from `fix_loop` before implementation-harness dispatch. It uses `schema_version: fix-attempt-intent.v1` and records run/`work_item` ids, `fix_attempt`, `max_fix_attempts`, current state/epoch, packet artifact ref, workspace id, failed verification/internal-review gate heads, `scope_boundary: approved_packet_artifact`, `dispatch_boundary: implementation-harness`, and the gates that must rerun.
- `artifacts/fix-loop/result-<hash>.json` — immutable sanitized fix-attempt result recorded after implementation-harness dispatch or reused on resume. It uses the same `implementation-dispatch-result.v1` result schema as the running-stage dispatch, but its `dispatch_intent_artifact` points at the fix-loop intent path and its artifact-ledger entry uses `gate_name: fix_attempt`, `recorded_from_state: fix_loop`, and provenance `kind: fix-attempt-result` with the attempt number and intent artifact ref.
- `verification.json` — verification commands/checks, outcomes, evidence, and the embedded `verification-policy.v1` artifact field.
- `internal-review/<hash>.json` — immutable local `internal-review-report.v1` findings, sanitized packet review context, sanitized independent reviewer result when supplied, and final review status. The report records `packet_review.verdict_artifact_path` from the approved packet's `review.verdict_artifact_path` and, when a verdict artifact is accepted, `reviewer_result.artifact_ref` with the immutable verdict path and hash.
- `internal-review/<verdict-name>.json` or another safe path under `artifacts/` referenced by `review.verdict_artifact_path` — independent reviewer verdict input with `schema_version: internal-review-verdict.v1`. The verdict JSON object must contain `status` (`PASS`, `FAIL`, or `BLOCKED`) and may include `reviewer`/`actor`, `summary`, `findings[]`, `evidence[]`, and `problem`. The adapter sanitizes this payload before copying it into the internal-review report; private prompt, transcript, stdout/stderr, output, log, and session-like fields are not retained in public reports or immutable review reports. Absolute paths, paths escaping the run directory, paths outside `artifacts/`, invalid JSON, unsupported statuses, or another `schema_version` block the gate instead of producing a PASS/FAIL.
- `pr/projection-intent-<hash>.json` — immutable local `handoff_target` projection intent derived from the approved local contract. The `pr/` path name is current GitHub-profile compatibility.
- `pr/projection-result-<hash>.json` — immutable local `handoff_target` projection result mirrored into provider projection fields only after a semantically valid successful projection record. Current `github.pr` / `projections.github_pr` mirrors are GitHub-profile compatibility views.

Implementation-dispatch `problem` uses a small safe shape: `code` plus generic `message`; extra raw adapter fields are intentionally not copied into immutable artifacts or public runner reports. `BLOCKED` keeps the run in `running`; `FAILED` transitions `running -> failed_execution`; only `COMPLETED` with durable evidence transitions to `verification`.

Fix-attempt dispatch uses the same sanitizer and durable-evidence rules, but from `fix_loop`. `COMPLETED` transitions back to `verification`, which creates a fresh execution epoch and resets verification/internal-review gate heads. Non-`COMPLETED` fix-attempt results keep the run in `fix_loop` with a structured blocker. The current local bound is two completed fix attempts; once exhausted, the next fix-loop pass transitions to `blocked_needs_human`.

When implementation dispatch blocks or fails, the public runner report records an explicit blocker/report shape:

- `implementation_dispatch.status` — dispatch result status: `BLOCKED`, `FAILED`, or `COMPLETED`.
- `implementation_dispatch.problem` — sanitized object with `code` and generic `message` when status is not `COMPLETED`; otherwise `null`/absent.
- `implementation_dispatch.intent_artifact_ref` — `{ path, sha256 }` reference to the recorded `artifacts/implementation-dispatch/intent-<hash>.json` artifact.
- `implementation_dispatch.result_artifact_ref` — `{ path, sha256 }` reference to the recorded or reusable `artifacts/implementation-dispatch/result-<hash>.json` artifact.
- `blockers[]` entry — `code: implementation_dispatch_blocked` for `BLOCKED` or `code: implementation_dispatch_failed` for `FAILED`, plus `dispatch_status`, nested `problem`, `intent_artifact_ref`, and `result_artifact_ref` mirroring the implementation-dispatch report.

Verification and review command records describe allowed adapters/gates from the approved packet and Buran policy. They must not become a general-purpose arbitrary script execution surface.

Internal review is completed by durable independent reviewer evidence, not by packet prose. The packet may provide `review.verdict_artifact_path` (or the legacy-compatible camelCase/result aliases accepted by the adapter) to identify an `internal-review-verdict.v1` artifact relative to the run directory and stored under `artifacts/`. If present and valid, the verdict artifact status becomes the internal-review gate status: `PASS` advances toward `pr_ready`, `FAIL` enters `fix_loop`, and `BLOCKED` enters `blocked_needs_human`. If no verdict artifact path is supplied, or the artifact is missing, corrupt, outside `artifacts/`, or schema/status-incompatible, the internal-review gate records `BLOCKED` with a structured problem such as `independent_internal_review_required`, `review_artifact_missing`, `review_artifact_invalid`, or `review_artifact_path_invalid`.

Recorded internal-review results are reusable only with intact independent verdict evidence. On resume, the report must still be `internal-review-report.v1`, the stored gate status must match `reviewer_result.status`, and `reviewer_result.artifact_ref` must point to an existing `internal-review-verdict.v1` artifact whose hash and status still match. Legacy PASS records without verdict artifact evidence, missing verdict artifacts, hash mismatches, invalid verdict JSON, or schema/status mismatches are treated as stale recorded results and do not advance the run.

Verification report artifacts (`schema_version: verification-report.v1`) include a durable `policy` object with `schema_version: verification-policy.v1`. The policy records the verification adapter contract used for the run:

- `adapter` — verification adapter id that interpreted the approved packet commands.
- `deterministic` — `true`; command selection and policy reporting must be deterministic for replay/recovery.
- `shell` — `false`; supported commands are executed through the adapter without shell expansion.
- `pass_requires_at_least_one_allowed_command` — `true`; a passing verification requires at least one requested command accepted by the adapter allowlist.
- `allowed_commands` — sorted adapter allowlist of command strings that may be requested by the packet.
- `requested_commands[]` — one entry per packet command after normalization. Allowed entries include `command`, `status: ALLOWED`, `adapter_command`, and `execution: execFile_no_shell`. Unsupported entries include `command`, `status: UNSUPPORTED`, and a sanitized `problem` object.

Recovery and consumers must treat `policy` as the durable reference for how packet verification commands were interpreted, not as authority to execute arbitrary commands outside the adapter allowlist.

## Registry store ordering

`src/integrations/storage/json-registry/store.js` centralizes multi-file mutation order. Current `execution-run.v2` ordering is:

- Intake: write packet artifact, initialize event journal, append `packet_received`, write `run.json`, commit sufficiency transition, then rebuild indexes.
- Transition: append the transition event, write the matching snapshot, release terminal lease records when needed, then rebuild indexes for terminal transitions.
- Artifact record: write artifact content, append `artifact.recorded`, update `run.json` artifact head/`last_sequence`, then return. Implementation-dispatch intent/result artifacts are recorded as `gate_name: implementation_dispatch` with `recorded_from_state: running`; resume reuses a current-epoch result artifact with matching dispatch intent and hash instead of invoking the adapter again. Fix-loop intent/result artifacts are recorded as `gate_name: fix_attempt` with `recorded_from_state: fix_loop`; resume reuses a current-epoch result artifact whose hash, attempt number, custom intent path, and dispatch intent match the current fix-attempt intent.
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
4. Semantically replay `artifact.recorded` and `gate.result_recorded` to rebuild gate/artifact heads, including implementation-dispatch and fix-attempt intent/result artifacts.
5. Verify the replayed state/heads/`last_sequence` match the snapshot.
6. Verify referenced artifact hashes where present.
7. Rebuild active-run and workspace-lease indexes.
8. Reclaim expired lease records by marking the owning run lease as `stale_recovered`, appending `recovery.lease_stale_reclaimed`, deleting local lease records, and reporting the finding. Recovery only reclaims when TTL has elapsed; it does not guess active ownership.
9. Remove terminal/orphan lease records from the local lease-record directory.
10. Semantically replay `projection.intent_recorded` / `projection.result_recorded` so provider projection mirrors, including current `github.pr` and `projections.github_pr` compatibility fields, are rebuilt from local event truth before `ready_for_manual_review` is trusted.
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
- Persisted shape changes require synchronized updates to `src/execution-runs/schema/index.js`, this document, and focused tests.
- Every schema change increments `schema_version`.
- Migrations must be explicit, idempotent, and recorded as recovery/migration events.
- No implementation may rely on undocumented fields.
- Registry and recovery remain local-only and do not emit external telemetry.
