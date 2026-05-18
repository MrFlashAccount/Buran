<p align="center">
  <img src="docs/assets/buran-logo-spaceplane.png" alt="Buran spaceplane" width="420">
</p>

<h1 align="center">Buran</h1>

<p align="center">
  <strong>Turn approved work into review-ready pull requests, in parallel.</strong>
</p>

<p align="center">
  Buran helps OpenClaw move tasks and plans through isolated agent runs, recover safely, and hand back clean PRs for review.
</p>

## Contents

- [What Buran does](#what-buran-does)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
- [Configuration](#configuration)
- [Recovery and review handoff](#recovery-and-review-handoff)

## What Buran does

Buran is the execution layer that takes already approved work and moves it forward without turning parallel delivery into a coordination mess. It gives OpenClaw a controlled way to run multiple implementation tracks at once, keep them separated, preserve evidence, and return clean handoffs for review.

- **Runs approved work in parallel.** Buran can move several approved tasks or plan packets forward at the same time, so OpenClaw is not forced into one-task-at-a-time execution just to stay safe.
- **Keeps each run isolated.** Every run stays bounded to its own workspace, lease, and execution contract, which reduces branch collisions, accidental overlap, and agent drift.
- **Tracks durable local state.** Buran records runs, events, and artifacts locally, so progress does not depend on fragile chat memory or manual status reconstruction.
- **Recovers interrupted work.** If a session stops halfway, Buran can rebuild state from recorded evidence, reclaim stale ownership conservatively, and resume without guessing what happened.
- **Hands back review-ready PRs.** The goal is not “some code changed”; the goal is a clean handoff with recorded state, finished execution, and a pull request ready for human review.

## Quick start

1. Add Buran to your OpenClaw workspace as a local plugin.
2. Set `registryRoot` in `openclaw.plugin.json` if you want Buran’s registry pinned to a specific path.
3. Prepare an approved task or plan packet with the execution details OpenClaw is allowed to use.
4. Start the run from OpenClaw so Buran can intake the approved work, reserve the workspace, and begin tracked execution.

## How to use it

1. **Approve the work first.** Buran is built for execution after planning, not for inventing missing scope or architecture on the fly.
2. **Send the approved packet into OpenClaw.** Buran validates the packet, records the run locally, and blocks if execution-critical information is missing.
3. **Let Buran keep the run controlled.** During execution it keeps ownership explicit, stores event history, and preserves enough state to recover if the session is interrupted.
4. **Review the handoff.** When the run finishes, Buran gives OpenClaw a review-ready result so a human can inspect the PR instead of reconstructing what happened.

## Configuration

| Setting | Where it lives | What it controls | Notes |
| --- | --- | --- | --- |
| `registryRoot` | OpenClaw plugin config (`openclaw.plugin.json`) | Root directory for Buran’s local registry | If omitted, Buran resolves the registry from the current workspace/runtime context. |
| Packet list path | Invocation input | Which approved tasks or plans Buran is allowed to execute | Required for validation and intake. Buran does not discover work on its own. |
| Run ID | Invocation input | Which recorded run to continue | Used when execution resumes after intake. |
| Workspace ID | Invocation input | Stable lease identity for the workspace doing the work | Helps prevent unsafe overlap between concurrent runs. |
| Workspace path | Invocation input | Which checkout or local working directory is leased for the run | Useful when a run must stay pinned to a specific local repo path. |
| Lease TTL | Invocation input | How long a workspace lease stays active before recovery can reclaim stale ownership | Optional override for longer-running work. |

## Recovery and review handoff

Buran is designed to keep recovery practical and handoff quality high.

When a run is interrupted, the local registry gives Buran enough evidence to resume conservatively instead of improvising. When a run completes, that same recorded state helps OpenClaw hand back a cleaner PR with less manual follow-up and less ambiguity about what actually happened.

For deeper implementation details, start with:

- [docs/state-machine.md](docs/state-machine.md)
- [docs/execution-run-schema.md](docs/execution-run-schema.md)
- [docs/github-projection-contract.md](docs/github-projection-contract.md)
