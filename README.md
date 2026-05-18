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

1. **Add Buran as a subtree inside your OpenClaw workspace.**

   ```bash
   git subtree add --prefix plugins/buran https://github.com/MrFlashAccount/Buran.git main --squash
   ```

2. **Add the plugin to your OpenClaw config** (for example `~/.openclaw/openclaw.json`).

   ```json
   {
     "plugins": {
       "load": {
         "paths": [
           "/absolute/path/to/your/openclaw-workspace/plugins/buran"
         ]
       },
       "entries": {
         "buran": {
           "enabled": true,
           "config": {
             "registryRoot": ".openclaw-runtime/plugins/buran/registry"
           }
         }
       }
     }
   }
   ```

   If your OpenClaw setup uses a plugin allowlist, add `buran` there too.

3. **In your OpenClaw chat, send the task you want Buran to execute.** A GitHub issue or comment URL works well because it gives OpenClaw a concrete approved task to turn into a tracked run.

   ```text
   Run this through Buran:
   https://github.com/your-org/your-repo/issues/123#issuecomment-0000000000

   Use repo checkout: /absolute/path/to/your/repo
   Use workspace id: repo-123
   When done, hand back the PR and anything still needing manual review.
   ```

4. **Wait for the run to finish, then review the PR or handoff.** Buran is there to move approved work forward cleanly, not to hide the review step.

## How to use it

1. **Start from approved work.** Buran is strongest when the issue, comment, or task packet already says what should be built and what constraints matter.
2. **Let OpenClaw turn that task into a Buran run.** Buran records the run locally, validates the execution inputs, and keeps workspace ownership explicit before it moves anything forward.
3. **Watch the run, not just the chat.** Buran keeps local run state, artifacts, and recovery data under its registry so interrupted sessions can resume with evidence instead of guesswork.
4. **Review the result like a real handoff.** The finish line is a review-ready PR with enough context to inspect the change, see what happened, and decide the next human step.

## Configuration

Most setups only need one plugin setting plus the run inputs OpenClaw passes when it executes a task.

| Setting | Where it lives | What it controls | Notes |
| --- | --- | --- | --- |
| `registryRoot` | OpenClaw plugin config | Root directory for Buran’s local registry | Optional. If omitted, Buran defaults to `.openclaw-runtime/plugins/buran/registry` inside the workspace/runtime context. |
| Packet list path | Run input | Which approved tasks or plans Buran is allowed to intake | Required when you are validating or intaking explicit packet lists. |
| Run ID | Run input | Which recorded run to continue | Used after intake, recovery, or a resumed execution step. |
| Workspace ID | Run input | Stable lease identity for the workspace doing the work | Helps keep parallel runs from colliding. |
| Workspace path | Run input | Which local checkout or working directory is leased for the run | Useful when the task must stay pinned to a specific repo path. |
| Lease TTL | Run input | How long a workspace lease stays active before recovery can reclaim stale ownership | Optional override for longer-running work. |

## Recovery and review handoff

Buran keeps enough local state to make interruptions recoverable and finished work easier to review.

- If a run stops halfway, Buran can rebuild state from the recorded registry instead of improvising.
- If a run completes, the same recorded artifacts help OpenClaw hand back a cleaner PR or review handoff.
- If you need the implementation details behind that flow, start with the docs below.

- [docs/state-machine.md](docs/state-machine.md)
- [docs/execution-run-schema.md](docs/execution-run-schema.md)
- [docs/github-projection-contract.md](docs/github-projection-contract.md)
