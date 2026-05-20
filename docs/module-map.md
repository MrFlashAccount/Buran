# Module Map

This file is the quick source-tree guide for maintainers. It maps the context-first source layout to implemented responsibilities.

## Top-level entrypoints

| Path | Responsibility |
| --- | --- |
| `index.js` | OpenClaw plugin export surface. |
| `bin/buran.js` | CLI wrapper for local command execution. |
| `src/entrypoints/cli.js` | argument parsing and command dispatch for `validate`, `intake`, `run`, `lease`, and `recover`. |
| `src/application/commands.js` | packet-list validation, intake orchestration, and CLI report assembly. |

## Core contexts

| Path | Responsibility |
| --- | --- |
| `src/approved-packets/sufficiency.js` | approved-packet normalization and PASS/FAIL sufficiency decisions. |
| `src/execution-runs/constants.js` | schema version, state names, transition constants, artifact-stage names, and shared limits. |
| `src/execution-runs/schema/` | `execution-run.v2` builders and validators for runs, batches, leases, and typed event payloads. |
| `src/execution-runs/state-machine.js` | allowed transition validation and terminal-state enforcement. |
| `src/execution-runs/registry/index.js` | compatibility export surface around registry operations. |
| `src/execution-runs/recovery/` | replay, validation, quarantine, stale-lease reclamation, index rebuild flow, and recovery report formatting. |
| `src/workspace-leases/contract.js` | provider-neutral lease request/status/path semantics. |
| `src/gates/verification-adapter.js` | allowlisted verification command execution and verification report generation. |
| `src/gates/internal-review-adapter.js` | local internal-review report generation that treats packet review text as context only. |
| `src/stack-workflow/review-ready-policy.js` | review-ready stack progression policy. |
| `src/workflow-boundary/pr-scm-projection/` | generic PR/SCM projection contract and local journal projection adapter. |
| `src/observability/` | redaction, public report sanitization, summaries, and observability path helpers. |
| `src/shared/primitives.js` | generic helpers such as hashing, string normalization, and utility checks. |

## Application orchestration

| Path | Responsibility |
| --- | --- |
| `src/application/run-local-mission.js` | thin state dispatcher for local mission runs. |
| `src/application/mission-context.js` | runner constants and mission context helpers. |
| `src/application/mission-phase-runner.js` | workspace-preparation and implementation-dispatch stage coordination. |
| `src/application/gate-pipeline.js` | verification and internal-review sequencing. |
| `src/application/fix-review-loop.js` | bounded fix-loop retry coordination. |
| `src/application/scm-handoff.js` | provider-neutral PR/SCM handoff coordination. |
| `src/application/final-report.js` | runner report and step/problem formatting. |

## External integrations

| Path | Responsibility |
| --- | --- |
| `src/integrations/storage/json-registry/` | JSON registry store, path layout, event journal, and atomic file writes. |
| `src/integrations/worktree/filesystem/locks.js` | filesystem-backed workspace lease acquisition/release and conflict detection. |
| `src/integrations/worktree/filesystem/workspace-preparation.js` | local git workspace inspection and immutable preparation artifact content. |
| `src/integrations/implementation/codex/dispatch-adapter.js` | implementation-dispatch and fix-attempt intent/result artifact contract. |
| `src/integrations/scm/github/pr-transport-adapter.js` | optional GitHub CLI stacked-PR transport adapter. |

## Test map

| Path | Coverage focus |
| --- | --- |
| `test/buran.test.js` | CLI and intake/validation behavior, sanitization, leases, projections, and recovery edges. |
| `test/execution-run-schema.test.js` | schema builders and snapshot validation. |
| `test/gate-ledger.test.js` | artifact/gate ledger semantics and projection recording constraints. |
| `test/registry-store.test.js` | registry write ordering, transitions, rebuilds, and recovery interactions. |
| `test/runner.test.js` | end-to-end local runner behavior across lease, verification, review, and PR projection stages. |
| `test/fixtures/packet-list.mixed.json` | mixed sufficient/insufficient packet intake fixture. |

## Current runtime flow

```text
packet list -> sufficiency -> registry intake -> queued
queued -> waiting_for_lock -> running
running -> workspace_preparation artifact -> implementation_dispatch intent artifact -> adapter call or reusable result -> sanitized result artifact
implementation_dispatch COMPLETED + durable evidence -> verification
implementation_dispatch BLOCKED -> stay running with blocker
implementation_dispatch FAILED -> failed_execution
verification -> verification artifact + gate -> internal_review | fix_loop | blocked_needs_human
internal_review -> internal-review artifact + gate -> pr_ready | fix_loop | blocked_needs_human
fix_loop -> fix_attempt intent artifact -> implementation-harness adapter call or reusable result -> sanitized fix_attempt result artifact
fix_attempt COMPLETED + durable evidence -> verification with fresh gate epoch
fix_attempt BLOCKED/FAILED -> stay fix_loop with blocker
bounded completed fix attempts exhausted -> blocked_needs_human
pr_ready -> projection intent/result artifacts -> ready_for_manual_review
next slice start -> workflow policy checks previous slice review-ready gates
recover -> replay + rebuild + quarantine when state is ambiguous
```

## What is intentionally absent

- no autonomous task discovery
- no direct implementation or fix worker execution inside the runner; worker execution is behind injected approved adapters
- no implementation worker execution outside the approved implementation-harness adapter boundary
- no fix-loop worker execution outside the approved implementation-harness adapter boundary
- no default remote GitHub write path in the CLI/runtime slice; live GitHub PR transport is injected and explicitly enabled only
- no dashboard or backlog management surface
