# Buran

![Buran spaceplane](docs/assets/buran-logo-spaceplane.png)

> Turn a task or plan into a pull request you can actually review.

Buran helps OpenClaw move from an approved task or plan to a clean PR, with a controlled workspace flow, recovery state, and a predictable review handoff.

## What it does

Buran is the execution layer after planning is already done.

You give it an approved packet list, it keeps the run local and structured, and it walks the work through validation, intake, execution, verification, internal review, and PR handoff.

That means:

- no vague “agent, go figure it out” mode
- no hidden remote state becoming the source of truth
- no messy overlap between workspaces
- no lost run when a session dies halfway through

The source of truth stays local in Buran’s registry, so OpenClaw can resume cleanly, audit what happened, and hand the result to a human reviewer without guesswork.

## Contents

- [Quick steps](#quick-steps)
- [Configuration](#configuration)
- [How the workflow runs](#how-the-workflow-runs)
- [Recovery and resume](#recovery-and-resume)
- [Review handoff](#review-handoff)

## Quick steps

1. Prepare an approved packet list.
2. Ask OpenClaw to validate it.
3. Intake the run into the local registry.
4. Start execution with a workspace lease.
5. Let Buran drive the run to verification, internal review, and PR-ready handoff.
6. If something interrupts the flow, recover the registry and resume from local state.

Typical OpenClaw flow:

```text
/buran validate --packets ./packet-list.json --json
/buran intake --packets ./packet-list.json --json
/buran run --run <run_id> --workspace-id <workspace_id> --workspace-path <workspace_path> --json
```

If the local state needs repair before continuing:

```text
/buran recover --json
```

## Configuration

| Setting | Where it lives | What it controls | Notes |
| --- | --- | --- | --- |
| `registryRoot` | OpenClaw plugin config (`openclaw.plugin.json`) | Root directory for Buran’s local registry | If omitted, Buran resolves the registry from the current workspace/runtime context. |
| Packet list path | Invocation input via `--packets` | Which approved tasks/plans Buran is allowed to execute | Required for validation and intake. Buran does not discover work on its own. |
| Run ID | Invocation input via `--run` | Which recorded run to continue | Used when execution or lease actions continue after intake. |
| Workspace ID | Invocation input via `--workspace-id` | Stable lease identity for the workspace doing the work | Helps prevent unsafe overlap between concurrent runs. |
| Workspace path | Invocation input via `--workspace-path` | Which checkout or local working directory is leased for the run | Useful when the run must be pinned to a specific local repo path. |
| Lease TTL | Invocation input via `--ttl-ms` | How long a workspace lease stays active before recovery can reclaim stale ownership | Optional override for longer-running work. |

## How the workflow runs

Buran is narrow on purpose. It starts only after the task or plan is already approved.

### 1. Validate the packet list

Buran checks that the packet list is explicit enough to execute. If the plan is missing branch details, verification expectations, review criteria, or other required execution data, the run stops instead of improvising.

### 2. Intake the run

Once the packet list passes, Buran records a durable local run. The registry keeps the run snapshot, event log, batch data, and artifacts together so OpenClaw can always reconstruct what happened.

### 3. Reserve the workspace

Before execution starts, Buran acquires a local workspace lease. The lease is designed to keep two runs from stepping on the same checkout, branch, issue, or conflict surface.

### 4. Execute and gate the work

A run moves through these phases:

`packet_received -> queued -> waiting_for_lock -> running -> verification -> internal_review -> pr_ready -> ready_for_manual_review`

The important part is not the labels. The important part is the contract:

- implementation happens inside the approved packet envelope
- verification must pass before review handoff
- internal review must pass before PR handoff
- blocked or failed states stay explicit instead of being papered over

### 5. Record the PR-ready handoff

When the gates pass, Buran records the PR projection result locally. In the current slice, that handoff is deterministic and local-first, which keeps the audit trail intact even when the final human review happens elsewhere.

## Recovery and resume

Buran is built for interrupted agent work.

If a session stops, a lease expires, or local indexes drift, recovery rebuilds the registry from recorded run state and event history instead of guessing.

That gives you a few practical benefits:

- stale leases can be reclaimed safely
- broken indexes can be rebuilt from the journal
- ambiguous state gets quarantined instead of silently trusted
- OpenClaw can resume from durable local evidence

The goal is simple: if the agent disappears halfway through, you should still know where the run stopped and what can safely continue.

## Review handoff

Buran is not trying to replace human review. It is trying to make the handoff clean.

By the time a run reaches `ready_for_manual_review`, Buran has already:

- preserved the local run history
- recorded verification and review outcomes
- kept workspace ownership explicit
- produced a deterministic PR-ready projection

So the reviewer gets a real handoff point instead of a half-finished agent story.

If you want the deeper contracts behind state transitions, registry storage, and PR projection behavior, start with:

- [docs/state-machine.md](docs/state-machine.md)
- [docs/execution-run-schema.md](docs/execution-run-schema.md)
- [docs/github-projection-contract.md](docs/github-projection-contract.md)
