# Buran

Buran is a local JSON-first execution boundary for already approved GitHub implementation packets.

## What Buran is for

Use Buran when planning is already done and approved, and you want the execution slice to stay auditable, gated, and local-first until handoff for manual review.

Buran owns the run lifecycle after packet approval and before human PR review. Its source of truth is a local registry, not GitHub state.

## What Buran does

- validates explicit packet lists before execution
- creates durable local `ExecutionRun` records with `run.json`, `events.jsonl`, and immutable artifacts
- moves runs through a defined lifecycle with verification and internal-review gates
- acquires conservative local workspace leases to avoid unsafe overlap
- records a local PR handoff projection in the current default runtime slice
- rebuilds indexes and quarantines ambiguous local state during recovery

## What Buran does not do

- discover tasks on its own
- create packets, architecture, or scope
- improvise when a packet is insufficient
- treat GitHub or TaskFlow as the source of truth
- perform real GitHub network writes by default in the CLI/runtime path
- auto-merge, supervise PRs after handoff, or move work to done

## First value in a few commands

These examples use the repo-local CLI entrypoint. Inside OpenClaw, the `/buran ...` slash surface maps to the same verbs and options.

Validate a real fixture packet list:

```bash
node ./bin/buran.js validate --packets ./test/fixtures/packet-list.mixed.json --json
```

Create local run state under a registry you control:

```bash
node ./bin/buran.js intake --packets ./test/fixtures/packet-list.mixed.json --registry /tmp/buran-registry --json
```

If the packet list is sufficient, Buran writes local state under:

```text
/tmp/buran-registry/batches/<batch_id>/batch.json
/tmp/buran-registry/runs/<run_id>/run.json
/tmp/buran-registry/runs/<run_id>/events.jsonl
```

From there, `run`, `lease acquire`, and `recover` operate on that local registry.

## Run lifecycle

At a high level, Buran moves an approved packet through these stages:

`packet_received -> queued -> waiting_for_lock -> running -> verification -> internal_review -> pr_ready -> ready_for_manual_review`

Blocked and failure states exist for weak packets, lock conflicts, human-required intervention, and unrecoverable execution failures. `pr_ready` means the gates passed and the run is ready for PR handoff logic; in the current local-only slice, the `pr_ready -> ready_for_manual_review` step records a deterministic local projection instead of doing a live GitHub write.

See [docs/state-machine.md](docs/state-machine.md) for the full transition contract.

## Local state and trust boundary

Buran is intentionally narrow.

- Input must be an explicit approved packet list.
- Local JSON registry state is authoritative.
- Verification and internal review must pass before PR handoff.
- Recovery repairs indexes and lease records from local run state, and quarantines ambiguous data instead of guessing.
- Observability stays local. There is no external telemetry.

Schema and storage details live in [docs/execution-run-schema.md](docs/execution-run-schema.md). PR handoff boundaries live in [docs/github-projection-contract.md](docs/github-projection-contract.md). Local observability surfaces live in [docs/observability.md](docs/observability.md).

## CLI surface

```text
/buran validate --packets <packet-list.json> [--json]
/buran intake --packets <packet-list.json> [--registry <path>] [--json]
/buran run --run <run_id> [--workspace-id <id>] [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran lease acquire --run <run_id> --workspace-id <id> [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]
/buran lease release --run <run_id> [--registry <path>] [--json]
/buran recover [--registry <path>] [--json]
```

`validate` and `intake` require `--packets`. There is no discovery fallback.

## Docs map

- [CONTEXT.md](CONTEXT.md): ownership and scope boundaries
- [ARCHITECTURE.md](ARCHITECTURE.md): selected architecture and non-goals
- [docs/state-machine.md](docs/state-machine.md): lifecycle states and gate rules
- [docs/execution-run-schema.md](docs/execution-run-schema.md): local registry contract
- [docs/github-projection-contract.md](docs/github-projection-contract.md): PR and projection rules
- [docs/observability.md](docs/observability.md): logs, diagnostics, and source-of-truth boundaries
- [docs/migration-plan.md](docs/migration-plan.md): migration notes from legacy/reference flows

## Development and checks

```bash
npm test
npm run check
node ./bin/buran.js validate --packets ./test/fixtures/packet-list.mixed.json --json
```

`npm test` and `npm run check` are maintainer checks for this repo. They are not the same thing as packet-selected verification inside a Buran run.
