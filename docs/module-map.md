# Module Map

This file maps the implemented source layout and canonical runtime surfaces.

## Entrypoints and composition

| Path | Responsibility |
| --- | --- |
| `index.js` | Plugin/export surface; imports canonical core execution-run constants/state machine. |
| `bin/buran.js` | CLI wrapper. |
| `src/entrypoints/cli.js` | CLI argument parsing and command dispatch. |
| `src/composition/local-runtime.js` | Local composition root wiring registry storage, workspace leases/inspection, implementation adapters, and the default SCM handoff adapter. |

## Provider-neutral core

| Path | Responsibility |
| --- | --- |
| `src/core/modules/execution-runs/` | Canonical execution-run entity, registry port, constants, transition/event builders, and state-machine authority. |
| `src/core/modules/scm-handoff/` | Canonical provider-neutral handoff target value object, projection contract helpers, SCM handoff port, projection entity, status/error authority, and projection service. |
| `src/core/modules/workspace-leases/` | Lease request/status contract, policy decisions, lease entity, and lease-service/record-store ports. |
| `src/core/ports/` | Provider-neutral cross-module/application seam ports and descriptor helpers that do not have enough domain rules to justify a core module. |
| `src/core/ports/integration.js` | Metadata validation/default helpers used by concrete integrations for composition/debug visibility; not a domain entity or lifecycle base class. |
| `src/core/ports/workspace-preparation-inspector.js` | Workspace preparation/inspection port; intentionally not a `modules/workspaces` module because no workspace entity/policy/value object exists in this slice. |
| `src/core/README.md` | Core dependency rules. |

## Execution-run application support

| Path | Responsibility |
| --- | --- |
| `src/execution-runs/schema/` | Durable `execution-run.v2` builders/validators; imports canonical core authority. |
| `src/execution-runs/recovery/` | Recovery/replay/quarantine flow; imports canonical core authority. |

## Application orchestration

| Path | Responsibility |
| --- | --- |
| `src/approved-packets/sufficiency.js` | Approved packet normalization and sufficiency decisions. |
| `src/application/run-local-mission.js` | Thin state dispatcher for local mission runs. |
| `src/application/mission-context.js` | Runner constants and mission context helpers. |
| `src/application/mission-phase-runner.js` | Workspace-preparation and implementation-dispatch coordination. |
| `src/application/gate-pipeline.js` | Verification/internal-review sequencing. |
| `src/application/fix-review-loop.js` | Bounded fix-loop retry coordination. |
| `src/application/scm-handoff.js` | Provider-neutral SCM handoff orchestration through an injected port. |
| `src/application/final-report.js` | Runner reports and problem formatting. |
| `src/gates/` | Implementation, verification, and internal-review artifact/gate contracts. |
| `src/stack-workflow/review-ready-policy.js` | Review-ready stack progression policy. |
| `src/application/recorded-artifacts.js` | Shared containment helper for recorded artifact references. |
| `src/observability/` | Redaction, public report sanitization, summaries, and observability path helpers. |
| `src/shared/primitives.js` | Generic helpers only; no Buran domain vocabulary. |

## Integrations

| Path | Responsibility |
| --- | --- |
| `src/integrations/storage/json-registry/` | Concrete JSON/filesystem registry adapter. |
| `src/integrations/worktree/filesystem/` | Concrete filesystem workspace lease and inspection adapters. |
| `src/integrations/scm/github/` | Optional GitHub-specific SCM handoff adapter/client/profile; live writes only when explicitly enabled by the embedding caller. |
| `src/integrations/scm/local-journal/` | Default no-network local SCM handoff adapter. |
| `src/integrations/implementation/codex/CONTEXT.md` | Reserved implementation integration note; core does not depend on it. |

## Boundary checks

`scripts/boundary-check.js` enforces:

- canonical core does not import application, composition, entrypoints, or integrations;
- provider-neutral SCM handoff contexts do not import concrete GitHub integrations;
- integrations do not import application/composition/entrypoints;
- removed wrapper paths are absent and not imported by runtime/tests;
- provider-neutral core does not contain provider-specific public vocabulary;
- shallow core module shells are rejected when a core module folder contains only ports and no entity, value object, policy, or service implementation;
- documented paths in this module map exist.

## Test map

| Path | Coverage focus |
| --- | --- |
| `test/buran.test.js` | CLI/intake/validation behavior, sanitization, leases, handoff projections, and recovery edges. |
| `test/execution-run-schema.test.js` | Schema builders and snapshot validation. |
| `test/gate-ledger.test.js` | Artifact/gate ledger semantics and handoff recording constraints. |
| `test/registry-store.test.js` | Registry write ordering, transitions, rebuilds, and recovery interactions. |
| `test/runner.test.js` | End-to-end local runner behavior across lease, verification, review, and SCM handoff stages. |
| `test/scm-handoff-architecture.test.js` | Provider-neutral SCM handoff core exports and port shape. |
| `test/scm-handoff-projection-adapter.test.js` | Handoff projection identity/collision protection. |

## Current runtime flow

```text
packet list -> sufficiency -> registry intake -> queued
queued -> waiting_for_lock -> running
running -> workspace_preparation -> implementation_dispatch -> verification
verification -> internal_review | fix_loop | blocked_needs_human
internal_review -> handoff_ready | fix_loop | blocked_needs_human
fix_loop -> fix_attempt -> verification | blocked_needs_human
handoff_ready -> SCM handoff intent/result artifacts -> ready_for_manual_review
recover -> replay + rebuild + quarantine when state is ambiguous
```

## Intentionally absent

- no autonomous `work_item` discovery;
- no direct implementation/fix worker execution in the runner;
- no default remote provider write path;
- no persisted schema migration for legacy provider-specific mirrors in this slice.
