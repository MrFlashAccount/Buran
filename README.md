<p align="center">
  <img src="docs/assets/buran-logo-spaceplane.png" alt="Buran spacecraft" width="720">
</p>

<h1 align="center">Buran</h1>

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
- local mission runner skeleton that can stage `queued` runs into `waiting_for_lock`, optionally acquire a local lease, record immutable workspace-preparation evidence plus an implementation-dispatch handoff artifact, execute packet-selected direct allowlisted verification commands for `verification` runs, execute a local-only internal-review adapter for `internal_review` runs, and record a local fake/no-network PR projection handoff for `pr_ready` before still stopping short of fix-loop implementation or real remote writes;
- local workspace-preparation skeleton for `running` runs that inspects a local git workspace/worktree, records immutable preparation evidence under the artifact ledger, derives a deterministic implementation-dispatch handoff artifact, and still stops before implementation worker execution;
- TTL metadata and stale-lease recovery that reports/reclaims expired local lease records without guessing active ownership;
- conflict blocking via `blocked_lock_conflict`, with rollback of partial local lock-file acquisition;
- recovery quarantine for unknown event types instead of accepting arbitrary timestamped events;
- quarantine of corrupt, malformed, incomplete, or ambiguous local run state under `registry/quarantine/` with `quarantine-report.json`;
- rebuildable `indexes/active-runs.json`, `indexes/workspace-leases.json`, and `indexes/recovery-report.json`;
- structured local operational logs and per-invocation diagnostic reports with trace ids, outcome/duration fields, and sanitization/redaction;
- exported Slice 7 PR projection transport seam for `pr_ready` handoff tests and future launch wiring, while the default CLI/runtime path still stays local-fake and no-network;
- no autonomous discovery, implementation worker dispatch, checkout/worktree setup, fix-loop implementation, or launch-pipeline wiring for real GitHub credentials/remote execution.

See [docs/observability.md](docs/observability.md) for the boundary between durable registry journals, operational logs, and diagnostic reports. Logs and diagnostics are local debugging aids only; registry state remains the source of truth and no external telemetry is emitted.

## Documentation map

- [ARCHITECTURE.md](ARCHITECTURE.md) — selected architecture, constraints, and decision record
- [CONTEXT.md](CONTEXT.md) — ownership and placement rules for this plugin folder
- [docs/context-map.md](docs/context-map.md) — upstream/downstream boundaries, handoff points, and side-effect map
- [docs/module-map.md](docs/module-map.md) — source-tree responsibilities and runtime flow by module
- [docs/state-machine.md](docs/state-machine.md) — lifecycle states, transitions, and gate rules
- [docs/execution-run-schema.md](docs/execution-run-schema.md) — local registry layout and persistence contract
- [docs/github-projection-contract.md](docs/github-projection-contract.md) — PR/comment/project projection semantics
- [docs/acceptance-scenarios.md](docs/acceptance-scenarios.md) — concrete behavior scenarios already covered by automated tests
- [docs/migration-plan.md](docs/migration-plan.md) — migration notes from legacy/reference queue surfaces

## Command

```bash
npm test
node ./bin/buran.js validate --packets ./test/fixtures/packet-list.mixed.json
node ./bin/buran.js intake --packets ./test/fixtures/packet-list.mixed.json --registry /tmp/buran-registry
node ./bin/buran.js run --run <run_id> --registry /tmp/buran-registry
node ./bin/buran.js lease acquire --run <run_id> --workspace-id ws-1 --registry /tmp/buran-registry
node ./bin/buran.js recover --registry /tmp/buran-registry
```

`npm test` and project-level commands such as `npm run check` remain valid manual/maintainer repo checks, but they are not part of Buran's packet-selected local verification allowlist.

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

`run` is local-only orchestration. Without `--workspace-id`, it can safely advance a queued run into `waiting_for_lock` and stop with a structured blocker. With `--workspace-id`, it may acquire a local lease, inspect a provided local git workspace/worktree path, record a `workspace_preparation` artifact, then record a deterministic `implementation_dispatch` handoff artifact and stop in `running` with `dispatch_ready_not_started`. For runs already in `verification`, packet-selected local verification supports only the safe direct-command allowlisted shape implemented in code (`node --test test/runner.test.js`, `node --test test/gate-ledger.test.js`). Package-script delegation such as `npm test` or `npm run check` is rejected for packet verification, though maintainers may still run those project-level checks manually outside packet verification. For runs already in `internal_review`, the local adapter reads `review.criteria` / `review.reviewer_plan` only as review context and never derives `PASS` / `FAIL` / `BLOCKED` from packet text. Local packet text therefore cannot force internal-review verdicts, including legacy strings such as `buran:internal_review=...` or `buran:review=...`; the local adapter records a blocked internal-review artifact that requires manual review evidence instead. For runs already in `pr_ready`, the default runner path records deterministic local PR projection intent/result artifacts plus `github.pr` / `projections.github_pr` handoff metadata with `projection_mode=local_fake`; no GitHub network write happens in the CLI/default runtime path, and the runner blocks instead of guessing a base branch when `github.base_branch` is missing from the approved local contract. Slice 7 also exports an injectable PR transport adapter seam for tests/future launch wiring: it still records local projection intent/result artifacts first, reuses intact current-epoch projection evidence idempotently, and blocks on corrupt artifacts or invalid transport results instead of pretending the PR handoff is healthy. Buran never dispatches implementation workers, creates a branch/worktree, or launches real GitHub credentials by default.

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
