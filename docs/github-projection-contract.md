# GitHub Projection Contract

GitHub, TaskFlow, comments, labels, and project fields are projection/journal surfaces. They never replace the local ExecutionRun registry as source of truth.

## Projection ownership

The projector reads local run state and writes remote updates. It records every attempt/result back into local artifacts/events with an idempotency key.

Allowed projection targets:

- issue comments;
- labels/status fields;
- project/TaskFlow fields;
- PR creation/update;
- PR comment with verification and internal review summary.

Forbidden projection behavior:

- deriving run state primarily from GitHub comments or labels;
- moving a task to Done;
- merging a PR;
- continuing to supervise a PR after `Ready for Manual Review`;
- expanding task scope based on remote comments without a new approved packet.

## Projection phases

| Local state | Remote projection |
| --- | --- |
| `queued` | Optional issue comment/status that execution was accepted in a manual batch. |
| `running` | Optional in-progress marker with workspace/run id. |
| `blocked_plan_insufficient` | Comment/status explaining missing packet data and required manual follow-up. |
| `blocked_lock_conflict` | Comment/status naming conflict surface if useful. |
| `verification` / `internal_review` | Usually local-only unless configured to publish progress. |
| `pr_ready` | Create/update PR, attach verification and internal review evidence; this is the PR creation/update step, not proof that a PR already exists. |
| `ready_for_manual_review` | Mark PR/task as `Ready for Manual Review`. |
| `blocked_needs_human` / `failed_execution` | Comment/status with concise evidence and next required human action. |

## Idempotency

Every remote write must include or derive a stable idempotency key from:

- `run_id`;
- projection target;
- local state/event sequence;
- target issue/PR id.

Retries must update or no-op existing projection records rather than duplicate comments when the remote API allows it. If duplication cannot be prevented, local projection logs must make duplicates auditable.

## PR creation gate

The projector may create or update a PR only when local state proves:

- verification gate is `PASS`;
- internal review gate is `PASS`;
- run has no unresolved lock/recovery ambiguity;
- branch/head/base data are present;
- artifact references exist for verification and review summaries.

After PR handoff, the local terminal state is `ready_for_manual_review`.

## Projection repair

Projection repair is allowed when remote state is missing or stale relative to local JSON.

Repair procedure:

1. Read local `run.json` and projection events.
2. Compute expected remote projection for the current state.
3. Compare by remote ids/idempotency keys where available.
4. Apply missing updates.
5. Record repair attempt/result in `events.jsonl` and `projection-log.jsonl`.

If local state is ambiguous, do not repair remote state; mark the run for human recovery.

## Comment content rules

Comments should be compact and evidence-based:

- current state;
- run id;
- verification status and artifact summary;
- internal review status and artifact summary;
- PR URL when available;
- required human action for blocked states.

Do not paste long logs. Link or reference local/PR artifacts instead.
