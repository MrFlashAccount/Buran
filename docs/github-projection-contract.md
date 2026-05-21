# SCM Handoff Projection Contract

This file documents the provider-neutral handoff contract used by the GitHub profile. Core Buran records `projection_ledger` intents/results for configured `handoff_target`s and tracker/review surfaces. GitHub, TaskFlow, comments, labels, project fields, and PRs are current adapter/profile surfaces only; they never replace the local ExecutionRun registry as source of truth.

Current implementation note: the default CLI/runtime `pr_ready` path uses a deterministic `local_fake` projection flow that records intent/result artifacts plus persisted `github.pr` / `projections.github_pr` metadata without a network write. A GitHub CLI-backed handoff transport is available only when explicitly enabled by the embedding caller, with a repo allowlist, explicit stacked `head_branch`/`base_branch`, recorded projection idempotency keys, and current-epoch verification/internal-review `PASS` evidence from the local workflow. Any transport-backed projection still records local intent first, validates the returned adapter payload against the local handoff contract, and fails closed in `pr_ready` on invalid/corrupt/blocked transport evidence.

## Projection ownership

The projector reads local run state and writes provider-specific updates through injected adapters. It records every attempt/result back into local artifacts/events with an idempotency key.

Allowed projection targets:

- `handoff_target` creation/update;
- review-thread comments;
- labels/status fields;
- tracker/project fields;
- review-target comment with verification and internal review summary.

Forbidden projection behavior:

- deriving run state primarily from provider comments, labels, or tracker state;
- moving a `work_item` to Done;
- merging a review target;
- continuing to supervise a handoff after `Ready for Manual Review`;
- expanding `work_item` scope based on remote comments without a new approved packet.

## Projection phases

| Local state | Provider projection |
| --- | --- |
| `queued` | Optional tracker/review status that execution was accepted in a manual batch. |
| `running` | Optional in-progress marker with workspace/run id. |
| `blocked_plan_insufficient` | Status/comment explaining missing packet data and required manual follow-up. |
| `blocked_lock_conflict` | Status/comment naming conflict surface if useful. |
| `verification` / `internal_review` | Usually local-only unless configured to publish progress. |
| `pr_ready` | Create/update the configured `handoff_target`, or in local fake mode record the deterministic handoff artifact that would drive creation/update. In the current GitHub profile this means PR creation/update; it is not proof that a real remote write already happened. |
| `ready_for_manual_review` | Mark the `handoff_target` / `work_item` as `Ready for Manual Review`. |
| `blocked_needs_human` / `failed_execution` | Status/comment with concise evidence and next required human action. |

## Idempotency

Every remote write must include or derive a stable idempotency key from:

- `run_id`;
- projection target;
- local state/event sequence;
- provider target id, when available;
- explicit handoff identity. In the current GitHub profile this includes `github.base_branch` and `github.intended_branch` for PR projection.

Retries must update or no-op existing projection records rather than duplicate comments when the provider API allows it. If duplication cannot be prevented, local projection logs must make duplicates auditable.

## Handoff creation gate

The projector may create or update a `handoff_target` only when local state proves:

- verification gate is `PASS`;
- internal review gate is `PASS`;
- run has no unresolved lock/recovery ambiguity;
- `scm_target` and handoff identity data are present;
- artifact references exist for verification and review summaries.

After handoff projection, the local terminal state is `ready_for_manual_review`. In local fake mode, that handoff is proven by the recorded projection artifact/result rather than a live provider response. In GitHub CLI transport mode, Buran first records the projection intent locally, then requires local workflow context (current epoch, projection idempotency keys, verification `PASS`, and internal-review `PASS`), creates or updates the open stacked PR for the exact head/base pair, records the validated result, and only then advances. The returned PR URL must match the configured GitHub host and the expected `owner/repo/pull/<number>` binding. Transport failure, disabled config, non-allowlisted repos, missing stack branches, missing workflow context, non-PASS gate evidence, remote stack mismatch, unavailable `gh`, auth failure, timeout, or invalid GitHub responses leave the run in `pr_ready` with a structured `pr_projection_*` blocker.

### Current GitHub CLI transport reliability

Live `gh` transport is a concrete adapter, not a core dependency. It runs with a minimal allowlisted environment rather than inheriting the caller process environment. By default it forwards only shell/location/auth values needed by GitHub CLI (`PATH`, `HOME`/XDG directories, `GH_TOKEN`/`GITHUB_TOKEN`, `GH_HOST`, `NO_COLOR`, `CI`) plus noninteractive guards (`GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`). Additional environment variables require explicit adapter opt-in. Every `gh` invocation is bounded by a timeout and CLI failures are reported as structured blockers such as `pr_projection_github_transport_disabled`, `pr_projection_github_repo_not_allowed`, `pr_projection_github_stack_incomplete`, `pr_projection_github_remote_mismatch`, `pr_projection_github_unavailable`, `pr_projection_github_auth_failed`, or `pr_projection_github_timeout`.

## Projection repair

Projection repair is allowed when remote state is missing or stale relative to local registry state.

Repair procedure:

1. Read local run snapshot and projection events.
2. Compute expected provider projection for the current state.
3. Compare by remote ids/idempotency keys where available.
4. Apply missing updates through the injected adapter.
5. Record repair attempt/result in `events.jsonl` and `projection-log.jsonl`.

If local state is ambiguous, do not repair remote state; mark the run for human recovery.

## Comment content rules

Comments should be compact and evidence-based:

- current state;
- run id;
- verification status and artifact summary;
- internal review status and artifact summary;
- handoff URL when available;
- required human action for blocked states.

Do not paste long logs. Link or reference local/handoff artifacts instead.
