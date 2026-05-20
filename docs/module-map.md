# Module Map

This file is the quick source-tree guide for maintainers. It maps the current code layout to responsibilities already implemented on this branch.

## Top-level entrypoints

| Path | Responsibility |
| --- | --- |
| `index.js` | OpenClaw plugin export surface. |
| `bin/buran.js` | CLI wrapper for local command execution. |
| `src/cli.js` | argument parsing and command dispatch for `validate`, `intake`, `run`, `lease`, and `recover`. |
| `src/buran.js` | packet-list validation and intake orchestration. |

## Core runtime modules

| Path | Responsibility |
| --- | --- |
| `src/constants.js` | schema version, state names, transition constants, artifact-stage names, and shared limits. |
| `src/state-machine.js` | allowed transition validation and terminal-state enforcement. |
| `src/packet-sufficiency.js` | approved-packet normalization and PASS/FAIL sufficiency decisions. |
| `src/runner.js` | local mission runner orchestration across `queued`, `waiting_for_lock`, `running`, `verification`, `internal_review`, bounded `fix_loop`, and `pr_ready`. |
| `src/locks.js` | workspace lease acquisition, conflict detection, TTL handling, and lease release. |
| `src/workspace-preparation.js` | local git workspace inspection and immutable preparation artifact content. |
| `src/implementation-dispatch.js` | implementation-dispatch and fix-attempt intent/result artifact builder, result sanitizer, custom intent-artifact provenance support, and durable completion-evidence contract. |

## Registry and persistence

| Path | Responsibility |
| --- | --- |
| `src/execution-run-schema.js` | `execution-run.v2` builders and validators for runs, batches, leases, and typed event payloads. |
| `src/registry-store.js` | canonical multi-file mutation ordering for snapshots, events, artifacts, leases, and indexes. |
| `src/registry.js` | compatibility export surface around registry operations. |
| `src/fs-atomic.js` | atomic write helpers used by registry persistence. |
| `src/recovery.js` | replay, validation, quarantine, stale-lease reclamation, and index rebuild flow. |

## Gate and projection adapters

| Path | Responsibility |
| --- | --- |
| `src/verification-adapter.js` | allowlisted verification command execution and verification report generation. |
| `src/internal-review-adapter.js` | local internal-review report generation that treats packet review text as context only. |
| `src/pr-projection-adapter.js` | local fake PR projection planning, artifact generation, and projection replay helpers. |
| `src/github-pr-transport-adapter.js` | injectable transport-backed PR projection seam plus disabled-by-default GitHub CLI stacked-PR create/update hook with repo allowlisting, local-first intent, sanitization, and result validation. |
| `src/projection-contract.js` | projection payload normalization and contract checks shared by projection code. |
| `src/observability.js` | redaction, public report sanitization, and observability path helpers. |

## Shared helpers

| Path | Responsibility |
| --- | --- |
| `src/utils.js` | generic helpers such as hashing, string normalization, and utility checks. |

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
recover -> replay + rebuild + quarantine when state is ambiguous
```

## What is intentionally absent

- no autonomous task discovery
- no direct implementation or fix worker execution inside the runner; worker execution is behind injected approved adapters
- no implementation worker execution outside the approved implementation-harness adapter boundary
- no fix-loop worker execution outside the approved implementation-harness adapter boundary
- no default remote GitHub write path in the CLI/runtime slice; live GitHub PR transport is injected and explicitly enabled only
- no dashboard or backlog management surface
