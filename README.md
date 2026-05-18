# Buran

![Buran spaceplane](docs/assets/buran-logo-spaceplane.png)

> Turn approved work into review-ready pull requests, in parallel.

Buran lets OpenClaw fan out approved tasks across isolated sessions and projects, keep each run recoverable, and hand back clean PRs for review. Less status tracking. More finished work.

## Why Buran exists

A lot of development work does not fail because the task is impossible. It stalls because someone has to keep checking status, restart half-finished execution, untangle workspace conflicts, and manually shepherd each item one by one.

Buran exists to remove that drag.

Once work is already approved, OpenClaw can move many tasks forward at the same time across different repos and workspaces, while still keeping each run bounded, inspectable, and safe to hand back for human review.

## What Buran does

Buran is the execution layer after planning and approval.

It takes approved work, records it as local run state, moves it through execution and gates, and prepares a review-ready handoff.

In practice, that means Buran helps OpenClaw:

- start from explicit approved task or plan packets
- run bounded execution sessions instead of freeform agent wandering
- keep durable local state for runs, artifacts, and event history
- recover cleanly when a session dies or local state drifts
- return a PR-ready or review-ready handoff instead of loose implementation progress

The source of truth stays local in Buran’s registry, so progress does not depend on fragile chat memory, remote comments, or manual status reconstruction.

## Parallel by design

Buran is not just for pushing one task from start to finish.

Its real value is letting OpenClaw move many approved tasks at once.

Different projects, different workspaces, different runs — active in parallel — without collapsing into chaos.

That parallelism is controlled, not reckless:

- each run starts only from approved work
- each workspace lease stays explicit
- each run keeps its own state and recovery trail
- verification and internal review still gate the handoff
- human review still happens before merge

So you get speed from concurrency, without pretending concurrency removes the need for boundaries.

## How the workflow stays controlled

Every run stays inside a narrow contract.

### Approved in, not guessed in

Buran expects explicit approved work. If the packet is missing execution-critical details, the run blocks instead of improvising.

### Isolated execution

Before work runs, Buran reserves workspace ownership so parallel sessions do not step on the same checkout, branch, issue, or conflict surface.

### Durable state

Runs are recorded locally with structured state, events, and artifacts, which makes interruption, audit, and continuation practical instead of messy.

### Recovery and resume

If an agent session stops midway, Buran can rebuild registry state, reclaim stale ownership conservatively, and continue from durable evidence rather than guesswork.

### Review-ready handoff

A run is not “done” just because code changed. Buran pushes toward a clean handoff: verification passed, internal review passed, state recorded, and the work ready for a human to review as a PR or equivalent handoff artifact.

## Configuration

| Setting | Where it lives | What it controls | Notes |
| --- | --- | --- | --- |
| `registryRoot` | OpenClaw plugin config (`openclaw.plugin.json`) | Root directory for Buran’s local registry | If omitted, Buran resolves the registry from the current workspace/runtime context. |
| Packet list path | Invocation input | Which approved tasks/plans Buran is allowed to execute | Required for validation and intake. Buran does not discover work on its own. |
| Run ID | Invocation input | Which recorded run to continue | Used when execution resumes after intake. |
| Workspace ID | Invocation input | Stable lease identity for the workspace doing the work | Helps prevent unsafe overlap between concurrent runs. |
| Workspace path | Invocation input | Which checkout or local working directory is leased for the run | Useful when a run must stay pinned to a specific local repo path. |
| Lease TTL | Invocation input | How long a workspace lease stays active before recovery can reclaim stale ownership | Optional override for longer-running work. |

## Review handoff

Buran is built to reduce manual follow-up, not remove human judgment.

By the time work reaches review handoff, Buran has already kept the run bounded, preserved the execution trail, and made parallel progress manageable.

That means reviewers get cleaner pull requests and clearer handoffs, while OpenClaw gets to keep many approved tasks moving at once.

If you want the deeper execution contracts behind state transitions, registry structure, and PR projection behavior, start with:

- [docs/state-machine.md](docs/state-machine.md)
- [docs/execution-run-schema.md](docs/execution-run-schema.md)
- [docs/github-projection-contract.md](docs/github-projection-contract.md)
