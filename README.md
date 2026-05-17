# buran

Local JSON-first Buran for already approved implementation packets.

## Current scope

Implemented now:

- explicit packet-list interface only;
- dry packet sufficiency validation;
- local intake that creates `runs/<run_id>/run.json`, `events.jsonl`, `artifacts/packet.md`, and `batches/<batch_id>/batch.json` under the configured registry;
- formal ExecutionRun state transition engine with allowed transitions, invalid-transition reasons, and terminal-state enforcement;
- `execution-run.v2` run snapshots with `last_sequence`, `execution.current_epoch`, gate head summaries, and recorded-artifact provenance;
- `queued` state for sufficient packets;
- `blocked_plan_insufficient` state for weak packets;
- consistent transition persistence through `run.json` plus monotonic `events.jsonl` transition events;
- local `recordArtifact(...)` and `recordGateResult(...)` APIs for verification/internal-review evidence with immutable artifact paths and gate-result idempotency;
- local recovery/replay command that validates schema, event sequence, transition edges, snapshot/event consistency, and artifact hashes;
- gate-aware transition guards that require fresh current-epoch verification/internal-review results before `verification -> internal_review`, `verification -> fix_loop`, `internal_review -> pr_ready`, and `internal_review -> fix_loop`;
- local workspace lease acquisition with lock surfaces for workspace, repo checkout, issue, branch, and declared conflict surfaces;
- local mission runner skeleton that can stage `queued` runs into `waiting_for_lock`, optionally acquire a local lease, and then stop before implementation/verification/review dispatch;
- local workspace-preparation skeleton for `running` runs that inspects a local git workspace/worktree, records immutable preparation evidence under the artifact ledger, and still stops before implementation dispatch;
- TTL metadata and stale-lease recovery that reports/reclaims expired local lease records without guessing active ownership;
- conflict blocking via `blocked_lock_conflict`, with rollback of partial local lock-file acquisition;
- recovery quarantine for unknown event types instead of accepting arbitrary timestamped events;
- quarantine of corrupt, malformed, incomplete, or ambiguous local run state under `registry/quarantine/` with `quarantine-report.json`;
- rebuildable `indexes/active-runs.json`, `indexes/workspace-leases.json`, and `indexes/recovery-report.json`;
- structured local operational logs and per-invocation diagnostic reports with trace ids, outcome/duration fields, and sanitization/redaction;
- no autonomous discovery, remote writes, implementation worker dispatch, verification/review adapter execution, checkout/worktree setup, PR creation, or projection adapter.

See [docs/observability.md](docs/observability.md) for the boundary between durable registry journals, operational logs, and diagnostic reports. Logs and diagnostics are local debugging aids only; registry state remains the source of truth and no external telemetry is emitted.

## Command

```bash
npm test
node ./bin/buran.js validate --packets ./test/fixtures/packet-list.mixed.json
node ./bin/buran.js intake --packets ./test/fixtures/packet-list.mixed.json --registry /tmp/buran-registry
node ./bin/buran.js run --run <run_id> --registry /tmp/buran-registry
node ./bin/buran.js lease acquire --run <run_id> --workspace-id ws-1 --registry /tmp/buran-registry
node ./bin/buran.js recover --registry /tmp/buran-registry
```

OpenClaw command form:

```text
/buran validate --packets <packet-list.json> [--json]
/buran intake --packets <packet-list.json> [--registry <path>] [--json]
/buran run --run <run_id> [--workspace-id <id>] [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran lease acquire --run <run_id> --workspace-id <id> [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran lease release --run <run_id> [--registry <path>] [--json]
/buran recover [--registry <path>] [--json]
```

`--packets` is mandatory for `validate` and `intake`. Buran intentionally has no discovery fallback. `lease acquire` reserves local state only; it does not create a checkout/worktree or run code. `recover` only inspects and repairs local registry indexes/quarantine/lease records; it has no external side effects.

`run` is local-only skeleton orchestration. Without `--workspace-id`, it can safely advance a queued run into `waiting_for_lock` and stop with a structured blocker. With `--workspace-id`, it may acquire a local lease, inspect a provided local git workspace/worktree path, and record a `workspace_preparation` artifact before stopping in `running`. It never dispatches implementation workers, creates a branch/worktree, or fabricates verification/review results.

## Config

```json
{
  "registryRoot": "/absolute/or/workspace-relative/path"
}
```

If omitted at runtime, the plugin resolves a local registry under the OpenClaw state directory when available, otherwise under the ignored `.openclaw-runtime/plugins/buran/registry` path for the current workspace.

Operational logs and diagnostic reports use the same local runtime root by default:

- `.openclaw-runtime/plugins/buran/logs/operational.jsonl`
- `.openclaw-runtime/plugins/buran/diagnostics/<trace_id>.json`

CLI JSON output includes an `observability` object with `trace_id`, `log_path`, and `diagnostic_report_path`.

## Packet sufficiency fields

A packet is sufficient when it has:

- approval marker (`approved: true`, `approval.approved: true`, or `approval.status: "approved"`);
- GitHub repo;
- issue number;
- intended branch;
- approved scope via goal or acceptance criteria;
- implementation instructions;
- verification expectations or commands;
- review criteria or reviewer plan;
- conflict surface.

Weak packets are recorded locally as `blocked_plan_insufficient`; Buran does not invent missing architecture or scope.
