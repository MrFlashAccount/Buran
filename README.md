<p align="center">
  <img src="docs/assets/buran-logo-spaceplane.png" alt="Buran spacecraft" width="720">
</p>

<h1 align="center">Buran</h1>

<p align="center">
  Local, JSON-first execution tracking for already approved GitHub implementation packets.
</p>

Buran is a focused OpenClaw plugin for taking an explicit list of approved implementation packets, validating whether they are sufficient to execute, and recording the resulting local run state with durable artifacts, transitions, leases, and recovery data.

It is intentionally narrow. Buran is not a planner, backlog manager, dashboard, or autonomous GitHub bot. On the current branch it stays local-first, records what happened, and only exposes a fake/local PR handoff path rather than performing default remote GitHub writes.

## Status

> Current branch status: implemented as a local-only execution boundary with validation, intake, lease management, recovery, verification/internal-review gate recording, and local PR projection artifacts.

What works today:

- explicit packet-list validation and intake;
- packet sufficiency checks that block weak packets instead of guessing missing scope;
- durable local registry state under `run.json`, `events.jsonl`, batch records, indexes, and immutable artifacts;
- a formal `execution-run.v2` state machine with recovery/replay and quarantine for corrupt or ambiguous state;
- local workspace lease acquisition with conflict detection and TTL recovery;
- local mission-runner stages for `queued`, `waiting_for_lock`, `running`, `verification`, `internal_review`, and `pr_ready`;
- allowlisted direct-command verification for a small safe command shape already covered by tests;
- local internal-review evidence recording that treats packet review text as context, not authority;
- deterministic local PR projection intent/result artifacts and `ready_for_manual_review` handoff.

What is intentionally not implemented in the default runtime path:

- autonomous task discovery;
- implementation worker execution from the `running` stage;
- fix-loop worker execution;
- default networked GitHub PR creation/update;
- merge automation, dashboard UI, or backlog ownership.

## Why Buran exists

Approved implementation packets still need disciplined execution. Buran gives that execution phase a narrow home:

- **local state is the source of truth** — not comments, labels, or remote queue state;
- **weak packets stop early** — no architectural improvisation when scope is missing;
- **every step is journaled** — transitions, leases, gate results, and artifacts are durable and replayable;
- **handoffs stay explicit** — verification, internal review, and PR projection are separate, inspectable stages.

## Quick start

### 1. Install and verify the repo

Buran is a plain Node.js ESM project and uses Node's built-in test runner.

```bash
git clone https://github.com/MrFlashAccount/Buran.git
cd Buran
npm install
npm test
npm run check
```

### 2. Validate an explicit packet list

```bash
node ./bin/buran.js validate --packets ./test/fixtures/packet-list.mixed.json
```

This performs dry sufficiency validation only. It does **not** create runs, discover tasks, or call external systems.

### 3. Intake packets into a local registry

```bash
node ./bin/buran.js intake \
  --packets ./test/fixtures/packet-list.mixed.json \
  --registry /tmp/buran-registry
```

For sufficient packets, intake creates local run and batch records. Insufficient packets are recorded as `blocked_plan_insufficient`.

### 4. Stage a run

```bash
node ./bin/buran.js run \
  --run <run_id> \
  --registry /tmp/buran-registry
```

For a queued run, this advances the run into `waiting_for_lock` unless a workspace lease is provided.

### 5. Acquire a local workspace lease

```bash
node ./bin/buran.js lease acquire \
  --run <run_id> \
  --workspace-id ws-1 \
  --registry /tmp/buran-registry
```

A lease reserves local execution surfaces only. It does not create a checkout, spawn a worker, or run arbitrary code.

### 6. Recover and rebuild registry indexes

```bash
node ./bin/buran.js recover --registry /tmp/buran-registry
```

Recovery replays the registry journal, rebuilds indexes, reclaims stale leases, and quarantines corrupt or ambiguous local state.

## How to use it

### CLI commands

```text
buran validate --packets <packet-list.json> [--json]
buran intake --packets <packet-list.json> [--registry <path>] [--json]
buran run --run <run_id> [--workspace-id <id>] [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
buran lease acquire --run <run_id> --workspace-id <id> [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
buran lease release --run <run_id> [--registry <path>] [--json]
buran recover [--registry <path>] [--json]
```

OpenClaw exposes the same surface through `/buran ...` once the plugin is loaded.

### Configuration

`openclaw.plugin.json` currently exposes one config field:

```json
{
  "registryRoot": "/absolute/or/workspace-relative/path"
}
```

If `registryRoot` is omitted, Buran resolves a local default registry:

- under the OpenClaw state directory when one is provided by the host runtime; or
- under `.openclaw-runtime/plugins/buran/registry` in the current workspace.

### Packet sufficiency rules

A packet is considered sufficient only when it provides:

- approval status;
- GitHub repository;
- issue number;
- intended branch;
- goal or acceptance criteria;
- implementation instructions;
- verification expectations or commands;
- review criteria or reviewer plan;
- conflict surface.

If that envelope is incomplete, Buran records `blocked_plan_insufficient` instead of inferring missing architecture or scope.

## Current execution model

The current runtime flow is intentionally bounded:

```text
packet list -> validation -> intake -> queued
queued -> waiting_for_lock -> running
running -> workspace_preparation artifact -> implementation_dispatch artifact -> stop
verification -> verification artifact + gate -> internal_review | fix_loop | blocked_needs_human
internal_review -> internal-review artifact + gate -> pr_ready | fix_loop | blocked_needs_human
pr_ready -> projection intent/result artifacts -> ready_for_manual_review
recover -> replay + rebuild + quarantine when state is ambiguous
```

A few important constraints:

- `run` is **local-only orchestration** on this branch;
- the `running` stage records `workspace_preparation` and `implementation_dispatch` artifacts, then stops before worker execution;
- packet-selected verification is intentionally allowlisted and rejects package-script delegation such as `npm test` or `npm run check`;
- the default `pr_ready` path records a local fake PR projection handoff and does not perform a remote GitHub write.

## Registry, state, and observability

Buran keeps three separate local evidence surfaces:

1. **Durable execution journal** — `registry/runs/<run_id>/run.json` plus `events.jsonl` are the source of truth.
2. **Operational logs** — `.openclaw-runtime/plugins/buran/logs/operational.jsonl` stores best-effort invocation breadcrumbs.
3. **Diagnostic reports** — `.openclaw-runtime/plugins/buran/diagnostics/<trace_id>.json` stores one sanitized summary per invocation.

Public CLI output includes an `observability` object with:

- `trace_id`
- `log_path`
- `diagnostic_report_path`

There is no external telemetry in the current implementation.

## Project map

### Start here

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — selected direction, constraints, and binding rules
- [`CONTEXT.md`](CONTEXT.md) — what belongs in this repo and what does not
- [`AGENTS.md`](AGENTS.md) — compact maintainer/agent guidance for working in the repo

### Detailed docs

- [`docs/context-map.md`](docs/context-map.md) — upstream/downstream boundaries and side effects
- [`docs/module-map.md`](docs/module-map.md) — source-tree responsibilities and runtime flow
- [`docs/state-machine.md`](docs/state-machine.md) — lifecycle states, transitions, and gate rules
- [`docs/execution-run-schema.md`](docs/execution-run-schema.md) — local registry layout and persistence contract
- [`docs/github-projection-contract.md`](docs/github-projection-contract.md) — projection and PR handoff semantics
- [`docs/acceptance-scenarios.md`](docs/acceptance-scenarios.md) — concrete scenarios already covered by tests
- [`docs/migration-plan.md`](docs/migration-plan.md) — migration notes from legacy/reference surfaces
- [`docs/observability.md`](docs/observability.md) — logging, diagnostics, sanitization, and trace correlation

### Code landmarks

- [`index.js`](index.js) — OpenClaw plugin export surface
- [`bin/buran.js`](bin/buran.js) — shell CLI entrypoint
- [`src/cli.js`](src/cli.js) — command parsing and dispatch
- [`src/buran.js`](src/buran.js) — validation, intake, config resolution, and formatting
- [`src/runner.js`](src/runner.js) — local mission runner orchestration
- [`src/registry-store.js`](src/registry-store.js) — canonical registry writes and ledger persistence
- [`src/recovery.js`](src/recovery.js) — replay, quarantine, and index rebuild flow

## Development

Repo checks used by this branch:

```bash
npm test
npm run check
git diff --check
```

The `check` script currently verifies that the plugin entrypoint imports cleanly, ignored runtime paths stay ignored, and `index.js`, `src/`, `bin/`, and `test/` pass Node syntax checks.

## Limitations and near-term roadmap

Current limitations:

- local-first only in the default CLI/runtime path;
- no implementation worker dispatch from `running`;
- no fix-loop worker implementation;
- verification adapters are intentionally narrow and allowlisted;
- remote PR transport exists as an injectable seam, not the default behavior.

Near-term roadmap implied by the existing architecture and docs:

- connect the recorded implementation-dispatch handoff to a real worker boundary;
- flesh out fix-loop execution inside the approved packet envelope;
- keep transport-backed PR projection contract-safe when remote writes are enabled deliberately;
- continue hardening recovery, artifact integrity, and resume behavior.

## License

[MIT](LICENSE)
