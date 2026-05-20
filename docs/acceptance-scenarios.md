# Acceptance Scenarios

These scenarios summarize the behavior the current branch already proves through automated tests. They are intentionally concrete and map to the implemented local-only slice.

## 1. Packet intake and sufficiency

### Scenario: sufficient packet becomes executable
- Given an approved packet with repo, issue, intended branch, implementation instructions, verification expectations, review criteria, and conflict surface
- When the packet list is validated and intaken
- Then the run is created in local registry state and transitions to `queued`

### Scenario: weak packet is blocked instead of improvised
- Given a packet missing required scope or implementation fields
- When intake runs
- Then the run transitions to `blocked_plan_insufficient`
- And no architecture or scope is invented locally

## 2. Lease and workspace staging

### Scenario: queued run waits for explicit lease input
- Given a `queued` run
- When the operator runs `buran run` without `--workspace-id`
- Then the run advances only to `waiting_for_lock`
- And the report returns a structured `lease_required` blocker

### Scenario: overlapping work is blocked conservatively
- Given another active run already holds conflicting issue, branch, or conflict-surface locks
- When lease acquisition is attempted
- Then Buran transitions the contender to `blocked_lock_conflict`
- And the report includes the conflicting lock surfaces

### Scenario: running stage dispatches through the implementation bridge
- Given a leased local workspace
- When the runner processes `running`
- Then it records immutable `workspace_preparation` and implementation-dispatch `intent-*` artifacts
- And it invokes the configured implementation-dispatch adapter only if no current `result-*` artifact is already reusable
- And it records a sanitized implementation-dispatch `result-*` artifact
- And it advances to `verification` only for `COMPLETED` results with durable changed-file evidence plus a durable result reference
- And `BLOCKED` results stay in `running` while `FAILED` results transition to `failed_execution`

## 3. Verification gate

### Scenario: allowlisted verification passes
- Given a run in `verification` with an allowlisted direct command such as `node --test test/runner.test.js`
- When the command passes
- Then Buran records a verification artifact and gate result
- And the run transitions to `internal_review`

### Scenario: failing verification enters fix loop
- Given a run in `verification`
- When the allowlisted verification command fails
- Then Buran records the FAIL result immutably
- And the run transitions to `fix_loop`

### Scenario: package-script delegation is rejected
- Given a run in `verification` whose packet asks for `npm test` or `npm run check`
- When the verification adapter evaluates the command
- Then Buran records a `BLOCKED` verification result
- And the run transitions to `blocked_needs_human`


## 4. Fix loop

### Scenario: bounded fix attempt returns to fresh verification
- Given a run in `fix_loop` after a verification or internal-review `FAIL`
- When the implementation-harness adapter returns a sanitized `COMPLETED` fix-attempt result with durable changed-file evidence and a durable result reference
- Then Buran records `artifacts/fix-loop/intent-*` and `artifacts/fix-loop/result-*` artifacts under the `fix_attempt` stage
- And the run transitions back to `verification` with a fresh execution epoch and reset gate heads

### Scenario: recorded fix-attempt result resumes safely
- Given a current-epoch fix-attempt result artifact already recorded in `fix_loop`
- When the run is retried from `fix_loop`
- Then Buran verifies the artifact hash and matching fix-attempt intent
- And reuses the result without dispatching a duplicate implementation-harness attempt

### Scenario: bounded attempts stop for human help
- Given completed fix attempts have already reached the local bound
- When the run reaches `fix_loop` again
- Then Buran transitions to `blocked_needs_human`
- And releases the local lease through the terminal transition path

## 5. Internal review gate

### Scenario: packet text cannot force internal-review verdicts
- Given review criteria or reviewer-plan text that contains directive-like strings such as `buran:internal_review=PASS`
- When internal review runs
- Then those strings are treated as context only
- And Buran records `BLOCKED` manual-review-required evidence instead of trusting packet text

### Scenario: independent verdict artifact can complete internal review
- Given a run in `internal_review` with an approved packet that sets `review.verdict_artifact_path`
- And that path points under the run's `artifacts/` directory to a valid `internal-review-verdict.v1` JSON artifact
- When internal review runs
- Then Buran records an `internal-review-report.v1` artifact that includes the sanitized reviewer result and verdict artifact reference
- And routes `PASS` verdicts to `pr_ready`, `FAIL` verdicts to `fix_loop`, and `BLOCKED` verdicts to `blocked_needs_human`

### Scenario: missing or invalid independent verdict evidence stays blocked
- Given a run in `internal_review` whose packet omits `review.verdict_artifact_path`, points outside `artifacts/`, or references a missing/invalid verdict artifact
- When internal review runs
- Then Buran records a `BLOCKED` internal-review result with a structured problem
- And packet prose or reviewer-plan text is not treated as approval evidence

### Scenario: recorded internal-review result can resume safely
- Given a current-epoch internal-review gate result with intact immutable artifacts
- When the run is retried from `internal_review`
- Then Buran reuses the recorded result without duplicating gate events
- And transitions according to that recorded status

## 6. PR handoff projection

### Scenario: local fake PR handoff completes the slice
- Given a run in `pr_ready` with passing current-epoch verification and internal review
- When the default projection path runs
- Then Buran records projection intent and result artifacts locally
- And mirrors the projection summary into `github.pr` / `projections.github_pr`
- And transitions to `ready_for_manual_review`
- And no remote GitHub write occurs

### Scenario: transport-backed projection remains contract-safe
- Given an injected PR transport adapter
- When it returns a valid result
- Then Buran records the projection intent before any transport call
- And records the projection result locally first-class
- And sanitizes secret-like repo or branch values in public-facing recorded payloads
- And can resume the recorded result idempotently without calling the transport again

### Scenario: GitHub CLI PR transport is opt-in and stacked
- Given GitHub PR transport is disabled or the repo is not allowlisted
- When a `pr_ready` run tries to project remotely
- Then Buran blocks in `pr_ready` without calling `gh`
- Given transport is enabled for an allowlisted repo
- When recorded projection idempotency keys and current-epoch verification/internal-review `PASS` evidence are present
- And the exact head/base pair has no open PR
- Then Buran creates a draft PR for that stack pair
- And when the pair already has an open PR, Buran updates it instead of creating a duplicate
- But if the local master workflow context or current `PASS` gate evidence is missing, Buran blocks before calling `gh`

### Scenario: invalid projection results do not advance the run
- Given an injected PR transport adapter that returns an invalid or corrupt result
- When projection recording is attempted
- Then Buran blocks in `pr_ready`
- And reports a structured projection problem instead of pretending handoff succeeded

## 6. Stack workflow enforcement

### Scenario: next slice waits for review-ready evidence
- Given a prerequisite slice run is not terminal in `ready_for_manual_review`
- Or its completed implementation dispatch/fix result, verification PASS, independent review PASS, or PR projection evidence is missing
- When a next stacked slice tries to start with that prerequisite
- Then Buran blocks before mutating the next run
- And the runner report lists every prerequisite gate as `PASS` or `BLOCKED`

### Scenario: recovery cannot skip workflow gates
- Given recovery rebuilds a valid but incomplete prerequisite run
- When stack progression policy is evaluated after recovery
- Then the next slice remains blocked until durable local evidence satisfies all review-ready gates

## 7. Recovery and ledger integrity

### Scenario: recovery preserves valid runs
- Given a valid local registry with coherent snapshot, events, and artifacts
- When `buran recover` runs
- Then indexes are rebuilt
- And valid runs remain available without quarantine

### Scenario: immutable artifact integrity is enforced on resume
- Given a previously recorded implementation-dispatch, fix-attempt, verification, internal-review, or PR projection artifact
- When the artifact is missing or no longer matches its recorded hash
- Then resume is blocked
- And Buran reports the artifact as missing or corrupt instead of silently reusing it

## Traceability to tests

Primary coverage lives in:

- `test/buran.test.js`
- `test/gate-ledger.test.js`
- `test/registry-store.test.js`
- `test/runner.test.js`

These scenarios are documentation of the tested slice, not a promise of unimplemented worker execution, default live GitHub writes, auto-merge, or Done automation.
