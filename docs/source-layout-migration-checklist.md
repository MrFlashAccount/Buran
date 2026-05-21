# Source Layout Migration Checklist

Implementation checklist for the approved source-layout refactor. This is a migration aid only; `ARCHITECTURE.md` remains unchanged.

## Inventory: old flat source path -> new context home

| Old path | New path / extraction set | Notes |
| --- | --- | --- |
| `src/buran.js` | `src/application/commands.js` | Command orchestration retained behind public entrypoints. |
| `src/cli.js` | `src/entrypoints/cli.js` | CLI grammar preserved. |
| `src/constants.js` | `src/core/modules/execution-runs/constants.js` | Durable state/schema constants stay core-owned. |
| `src/execution-run-schema.js` | `src/execution-runs/schema/{index.js,builders.js,validators.js}` | Builders/defaults separated from validators; public schema exports preserved through `index.js`. |
| `src/fs-atomic.js` | `src/integrations/storage/json-registry/fs-atomic.js` | Concrete filesystem atomic write primitive. |
| `src/github-pr-transport-adapter.js` | `src/integrations/scm/github/github-scm-handoff-adapter.js` | GitHub-specific transport isolated under SCM integration. |
| `src/implementation-dispatch.js` | `src/gates/implementation-contract.js` | Gate-facing implementation dispatch contract/evidence validation. |
| `src/internal-review-adapter.js` | `src/gates/internal-review-adapter.js` | Internal review gate adapter retained under gates. |
| `src/locks.js` | `src/workspace-leases/contract.js`, `src/integrations/worktree/filesystem/locks.js` | Lease semantics separated from filesystem-backed lock adapter. |
| `src/observability.js` | `src/observability/{index.js,public-output.js,redaction.js}` | Public output/report summaries split from reusable privacy redaction helpers. |
| `src/packet-sufficiency.js` | `src/approved-packets/sufficiency.js` | Approved packet validation context. |
| `src/pr-projection-adapter.js` | `src/core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js` | Provider-neutral local PR/SCM projection journal. |
| `src/projection-contract.js` | `src/core/modules/scm-handoff/contract.js` | Generic PR/SCM projection contract. |
| `src/recovery.js` | `src/execution-runs/recovery/index.js`, `src/execution-runs/recovery/reporting.js` | Public recovery report formatting extracted; replay/apply semantics kept co-located to avoid event-order drift. |
| `src/registry-store.js` | `src/integrations/storage/json-registry/{store.js,path-layout.js,atomic-read-write.js,event-journal.js,indexes-snapshots.js,lease-records.js,fs-atomic.js}` | Store facade split from paths, atomic writes, event journal, indexes/snapshot hashing, and lease-record file helpers. |
| `src/registry.js` | `src/core/modules/execution-runs/ports/registry-repository.js` | Core registry boundary export surface. |
| `src/runner.js` | `src/application/{run-local-mission.js,mission-context.js,mission-phase-runner.js,gate-pipeline.js,fix-review-loop.js,scm-handoff.js,final-report.js}` | Thin mission dispatcher plus phase/gate/fix/projection/report modules. |
| `src/state-machine.js` | `src/core/modules/execution-runs/state-machine.js` | Core transition rules. |
| `src/utils.js` | `src/shared/primitives.js` | Generic primitives only. |
| `src/verification-adapter.js` | `src/gates/verification-adapter.js` | Verification gate adapter. |
| `src/workflow-policy.js` | `src/stack-workflow/review-ready-policy.js` | Stack review-ready policy. |
| `src/workspace-preparation.js` | `src/integrations/worktree/filesystem/workspace-preparation.js` | Filesystem/git worktree inspection integration. |

## Structural extraction status

- `runner.js`: extracted into mission context, phase runner, gate pipeline, fix/review loop, SCM handoff, and final report modules.
- `registry-store.js`: extracted into storage facade, path layout, atomic read/write, event journal, indexes/snapshots, and lease-record helpers.
- `execution-run-schema.js`: split into schema builders, validators, and context index exports.
- `observability.js`: split into public output and redaction helpers while keeping observer lifecycle in `index.js`.
- `recovery.js`: report formatting extracted; replay/apply logic remains co-located because the current replay validation depends on ordered event application and semantic comparison in one flow.
- `locks.js`: provider-neutral lease contract extracted; filesystem acquisition/release remains in filesystem worktree integration.

## Exceptions / follow-up notes

- No behavior-changing schema, state-machine, gate, registry-format, projection, command-grammar, or terminal handoff changes were made intentionally.
- Recovery replay/apply was not split into separate `planning.js`, `detection.js`, and `apply.js` files in this pass. The file is below the backend review-size threshold and further slicing would add interface churn around event ordering; keep this as a reviewer hotspot rather than a hidden semantic rewrite.
