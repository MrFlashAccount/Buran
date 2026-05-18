<p align="center">
  <img src="docs/assets/buran-logo-spaceplane.png" alt="Buran spacecraft" width="720">
</p>

<h1 align="center">Buran</h1>

<p align="center">
  A local execution boundary for approved GitHub implementation packets in OpenClaw.
</p>

Buran gives the execution phase its own disciplined home.

When a task is already researched, approved, and shaped into an implementation packet, Buran validates that packet, turns it into durable local run state, enforces workspace/branch/conflict locks, records verification and review evidence, and prepares PR handoff data without treating GitHub comments or queue state as the source of truth.

## Table of contents

- [Why Buran exists](#why-buran-exists)
- [What Buran does](#what-buran-does)
- [Quick start](#quick-start)
- [Use it from OpenClaw](#use-it-from-openclaw)
- [CLI commands](#cli-commands)
- [Core concepts](#core-concepts)
- [Architecture and docs](#architecture-and-docs)
- [Development checks](#development-checks)
- [Current status and limits](#current-status-and-limits)
- [Roadmap direction](#roadmap-direction)
- [License](#license)

## Why Buran exists

A lot of agent systems are good at planning and bad at execution discipline.

Once a task is approved, you still need something that can say:

- is this packet actually executable,
- what run state exists right now,
- which workspace or branch is already reserved,
- what evidence was recorded,
- whether verification and review really passed,
- and whether a PR handoff is ready.

Buran is that boundary.

It is intentionally narrow. It does not try to be a planner, backlog manager, autonomous task discovery service, or general background worker. It focuses on the part between “this task is approved” and “this is ready for manual review.”

## What Buran does

Today, Buran provides:

- **explicit packet intake** from JSON packet lists only
- **packet sufficiency checks** that block weak tasks instead of improvising missing scope
- **local registry state** with `run.json`, `events.jsonl`, artifacts, batch snapshots, lease files, and derived indexes
- **workspace lease and conflict control** across workspace, checkout path, repo, issue, branch, and declared conflict surface
- **runner staging** for queued runs and local handoff recording in the `running` stage
- **verification and internal-review gate recording** with immutable artifacts and gate results
- **PR projection handoff recording** as a local, deterministic projection in the current default path
- **recovery and replay** that rebuild indexes, reclaim stale leases, and quarantine ambiguous state

The important design choice: **local JSON state is the source of truth**. Remote systems are projections from that state, not the other way around.

## Quick start

### 1. Clone the repo and run the repo checks

```bash
git clone https://github.com/MrFlashAccount/Buran.git
cd Buran
npm install
npm test
npm run check
```

Buran is a Node.js ESM project with a shell CLI in `bin/buran.js` and an OpenClaw plugin entry in `index.js`.

### 2. Create a packet list

Buran only accepts explicit packet lists. A packet must be approved and include enough execution detail to avoid guesswork.

Minimal example:

```json
{
  "packets": [
    {
      "task_id": "example-task-17",
      "approved": true,
      "github": {
        "repo": "example-owner/example-repo",
        "issue_number": 17,
        "intended_branch": "user/example-task-17",
        "base_branch": "main"
      },
      "scope": {
        "goal": "Implement the approved change.",
        "acceptance_criteria": [
          "The behavior matches the approved packet"
        ]
      },
      "implementation": {
        "instructions": "Touch only the approved files and stay inside scope."
      },
      "verification": {
        "commands": [
          "node --test test/runner.test.js"
        ]
      },
      "review": {
        "criteria": [
          "Confirm the change stays inside the approved packet envelope"
        ]
      },
      "conflict_surface": [
        "src/example-area/"
      ]
    }
  ]
}
```

Sufficiency for intake currently requires:

- approval
- `github.repo`
- `github.issue_number`
- `github.intended_branch`
- goal or acceptance criteria
- implementation instructions
- verification expectations or commands
- review criteria or reviewer plan
- conflict surface

If you want to use the PR projection handoff path later, include `github.base_branch` too.

### 3. Validate the packet list

```bash
node ./bin/buran.js validate --packets ./packets.json
```

This is a dry check. It does not create runs, discover work, or call external systems.

### 4. Intake packets into a local registry

```bash
node ./bin/buran.js intake \
  --packets ./packets.json \
  --registry ./tmp/buran-registry
```

Intake creates durable local run records for sufficient packets and records insufficient packets as `blocked_plan_insufficient`.

### 5. Stage a run

```bash
node ./bin/buran.js run \
  --run <run_id> \
  --registry ./tmp/buran-registry
```

For a queued run, this moves the run to `waiting_for_lock` and tells you a lease is required.

Acquire a lease:

```bash
node ./bin/buran.js lease acquire \
  --run <run_id> \
  --workspace-id ws-1 \
  --workspace-path ./some-worktree \
  --registry ./tmp/buran-registry
```

Run again:

```bash
node ./bin/buran.js run \
  --run <run_id> \
  --registry ./tmp/buran-registry
```

In the current default slice, Buran records `workspace_preparation` and `implementation_dispatch` artifacts, then stops before worker execution.

### 6. Recover and rebuild derived state

```bash
node ./bin/buran.js recover --registry ./tmp/buran-registry
```

Recovery replays runs, rebuilds indexes, reclaims stale leases, and quarantines ambiguous or corrupt local state.

## Use it from OpenClaw

This repo already exposes the two integration surfaces Buran supports:

- **shell CLI** via `bin/buran.js`
- **OpenClaw plugin** via `index.js`

The package declares `./index.js` in `package.json` under `openclaw.extensions`, and the plugin registers the `buran` command name. That means the command surface is the same in both places:

- shell: `node ./bin/buran.js ...`
- OpenClaw: `/buran ...`

Current plugin config:

```json
{
  "registryRoot": "/absolute/or/workspace-relative/path"
}
```

If `registryRoot` is omitted, Buran resolves the registry to:

- `<stateDir>/plugins/buran/registry` when the OpenClaw host provides a state directory, or
- `<workspace>/.openclaw-runtime/plugins/buran/registry` otherwise.

## CLI commands

```text
/buran validate --packets <packet-list.json> [--json]
/buran intake --packets <packet-list.json> [--registry <path>] [--json]
/buran run --run <run_id> [--workspace-id <id>] [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran recover [--registry <path>] [--json]
/buran lease acquire --run <run_id> --workspace-id <id> [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran lease release --run <run_id> [--registry <path>] [--json]
```

A useful mental model:

| Command | Purpose |
| --- | --- |
| `validate` | Check whether packet data is sufficient to execute. |
| `intake` | Create local batch/run state in the registry. |
| `run` | Advance one run through the implemented local runner slice. |
| `lease acquire` | Reserve local execution surfaces for a run. |
| `lease release` | Release an acquired lease. |
| `recover` | Replay the registry and rebuild derived indexes. |

### Verification command model

The current verification adapter is intentionally narrow. It only executes a local allowlist of direct commands, currently including:

- `node --test test/runner.test.js`
- `node --test test/gate-ledger.test.js`

Package-script delegation like `npm test` or `npm run check` is intentionally blocked in the verification gate.

## Core concepts

### Approved packets, not discovered work

Buran does not discover tasks or write the packet for you. It starts from an explicit approved packet list.

### Local registry as source of truth

Every run is tracked locally with durable state and an append-only event journal.

Main registry surfaces:

- `registry/runs/<run_id>/run.json`
- `registry/runs/<run_id>/events.jsonl`
- `registry/runs/<run_id>/artifacts/...`
- `registry/batches/<batch_id>/batch.json`
- `registry/leases/*.json`
- `registry/indexes/*.json`

### Leases and conflict surfaces

Buran uses conservative local locking across:

- workspace id
- workspace path / checkout path
- repo
- issue
- branch
- declared conflict surface

That lets multiple workspaces run in parallel when their lock surfaces do not overlap.

### Gates are recorded, not assumed

Verification and internal review are first-class gate results with immutable artifacts and epoch/attempt tracking.

### PR handoff is a projection

In the current default runtime path, `pr_ready` records a deterministic local PR projection and transitions to `ready_for_manual_review`. The default path does not perform remote GitHub writes.

### Observability stays local

Buran keeps three local evidence surfaces:

1. the durable run journal
2. operational logs under `.openclaw-runtime/plugins/buran/logs/`
3. per-invocation diagnostic reports under `.openclaw-runtime/plugins/buran/diagnostics/`

Public output includes `trace_id`, `log_path`, and `diagnostic_report_path` so a run can be traced back to local evidence.

## Architecture and docs

Start here:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — selected direction, constraints, and binding rules
- [`CONTEXT.md`](CONTEXT.md) — ownership boundary for this repo
- [`AGENTS.md`](AGENTS.md) — compact repo guidance for future agents/maintainers

Detailed docs:

- [`docs/context-map.md`](docs/context-map.md) — upstream/downstream boundaries and side effects
- [`docs/module-map.md`](docs/module-map.md) — source-tree responsibilities and runtime flow
- [`docs/state-machine.md`](docs/state-machine.md) — lifecycle states and transitions
- [`docs/execution-run-schema.md`](docs/execution-run-schema.md) — registry layout and persistence contract
- [`docs/github-projection-contract.md`](docs/github-projection-contract.md) — PR/projection rules
- [`docs/acceptance-scenarios.md`](docs/acceptance-scenarios.md) — tested behavior summary
- [`docs/migration-plan.md`](docs/migration-plan.md) — migration notes from legacy/reference surfaces
- [`docs/observability.md`](docs/observability.md) — logging, diagnostics, and sanitization

## Development checks

Run these before claiming a change is ready:

```bash
npm test
npm run check
git diff --check
```

What `npm run check` covers on this branch:

- imports the plugin entrypoint
- verifies ignored runtime paths stay ignored
- syntax-checks `index.js`, `src/`, `bin/`, and `test/`

## Current status and limits

Buran is already useful as a local execution-state boundary, but the current default runtime slice is still deliberately bounded.

Current limits:

- no autonomous task discovery
- no worker execution from the `running` stage
- no implemented fix-loop worker path
- verification is allowlist-only, not arbitrary command execution
- the default PR handoff path is local projection, not a live GitHub write
- Buran stops at `ready_for_manual_review`; it does not merge or babysit PRs

## Roadmap direction

The architecture and current seams point toward a larger execution system, but the repo does not pretend those parts are already done.

Likely next steps from the existing design:

- connect implementation-dispatch recording to a real worker boundary
- flesh out the fix-loop execution path inside the approved packet envelope
- keep transport-backed PR projection contract-safe when remote writes are enabled deliberately
- continue hardening replay, artifact integrity, and resume behavior

## License

[MIT](LICENSE)
