import { SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
import { acquireWorkspaceLease } from "./locks.js";
import { getRunPaths, readRunSnapshot, transitionRun } from "./registry-store.js";
import { nonEmptyString } from "./utils.js";

const RUNNER_MODE = "run_local";
const RUNNER_ACTOR = "local-mission-runner";

function hasActiveLease(snapshot) {
  return snapshot?.workspace?.lease_status === "acquired" || snapshot?.locks?.lease_status === "acquired";
}

function buildStep({ action, status, fromState = "", toState = "", detail = "", sequence = null, workspaceId = "", leaseId = "", expiresAt = "", conflicts = 0, rolledBackRecords = 0 } = {}) {
  const step = {
    action,
    status,
    from_state: fromState,
    to_state: toState,
  };
  if (detail) step.detail = detail;
  if (Number.isSafeInteger(sequence)) step.sequence = sequence;
  if (workspaceId) step.workspace_id = workspaceId;
  if (leaseId) step.lease_id = leaseId;
  if (expiresAt) step.expires_at = expiresAt;
  if (conflicts > 0) step.conflicts = conflicts;
  if (rolledBackRecords > 0) step.rolled_back_records = rolledBackRecords;
  return step;
}

function buildIssue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function buildRunnerReport({ registryRoot, runId, previousState = null, currentState = null, outcome, stepsTaken = [], blockers = [], warnings = [] } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    mode: RUNNER_MODE,
    registry_root: registryRoot,
    run_id: runId,
    outcome,
    status: outcome,
    previous_state: previousState,
    current_state: currentState,
    steps_taken: stepsTaken,
    blockers,
    warnings,
    external_side_effects: false,
  };
}

function leaseRequiredMessage(runId) {
  return `Run ${runId} is waiting_for_lock. Acquire a local lease with buran lease acquire --run ${runId} --workspace-id <id> or rerun with --workspace-id.`;
}

function implementationBoundaryMessage() {
  return "Local mission runner skeleton stops before implementation dispatch. Slice 4A does not start workers, verification, review, or external writes.";
}

function unsupportedStageMessage(state) {
  return `Local mission runner skeleton does not execute ${state} adapters yet.`;
}

export async function runLocalMission({ registryRoot, runId, workspaceId = "", workspacePath = "", ttlMs = "", clock = () => new Date(), actor = RUNNER_ACTOR } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for local mission runner");
  if (!runId) throw new Error("runId is required for local mission runner");

  const stepsTaken = [];
  const blockers = [];
  const warnings = [];
  const paths = getRunPaths(registryRoot, runId);

  let snapshot;
  try {
    snapshot = await readRunSnapshot(paths.runPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return buildRunnerReport({
        registryRoot,
        runId,
        outcome: "failed",
        blockers: [buildIssue("run_not_found", `Run ${runId} was not found in the local registry.`)],
      });
    }
    throw error;
  }

  const previousState = snapshot.state;
  let current = snapshot;

  if (TERMINAL_STATES.has(current.state)) {
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      blockers: [buildIssue("terminal_state", `Run ${runId} is already terminal in state ${current.state}.`)],
    });
  }

  if (current.state === "packet_received") {
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      blockers: [buildIssue("run_not_intaken", `Run ${runId} is still in packet_received and is not ready for local runner staging.`)],
    });
  }

  if (current.state === "queued") {
    const transitioned = await transitionRun(registryRoot, runId, {
      toState: "waiting_for_lock",
      actor,
      evidence: { reason: "local mission runner staged run for lease acquisition" },
      clock,
    });
    current = transitioned.run;
    stepsTaken.push(buildStep({
      action: "transition",
      status: "completed",
      fromState: previousState,
      toState: current.state,
      detail: "Queued run staged for explicit local lease acquisition.",
      sequence: transitioned.event.sequence,
    }));
  }

  if (current.state === "waiting_for_lock") {
    if (!nonEmptyString(workspaceId)) {
      blockers.push(buildIssue("lease_required", leaseRequiredMessage(runId)));
      return buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "blocked",
        stepsTaken,
        blockers,
        warnings,
      });
    }

    const acquired = await acquireWorkspaceLease(registryRoot, runId, {
      workspaceId,
      workspacePath,
      ttlMs,
      actor,
      clock,
    });
    current = acquired.run;

    if (acquired.status === "acquired") {
      stepsTaken.push(buildStep({
        action: "lease_acquire",
        status: "completed",
        fromState: "waiting_for_lock",
        toState: current.state,
        detail: "Local workspace lease acquired without creating a checkout or dispatching work.",
        workspaceId: acquired.lease?.workspace_id || workspaceId,
        leaseId: acquired.lease?.lease_id || "",
        expiresAt: acquired.lease?.expires_at || "",
      }));
    } else {
      stepsTaken.push(buildStep({
        action: "lease_acquire",
        status: "blocked",
        fromState: "waiting_for_lock",
        toState: current.state,
        detail: "Local lease acquisition stopped on an unsafe overlap.",
        conflicts: acquired.conflicts?.length || 0,
        rolledBackRecords: acquired.rolled_back_records || 0,
      }));
      blockers.push(buildIssue("blocked_lock_conflict", "Local lease acquisition detected an unsafe overlap.", {
        conflicts: acquired.conflicts || [],
      }));
      return buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "blocked",
        stepsTaken,
        blockers,
        warnings,
      });
    }
  }

  if (current.state === "running") {
    if (!hasActiveLease(current)) {
      warnings.push(buildIssue("lease_not_active", `Run ${runId} is in running without an active local lease snapshot.`));
      blockers.push(buildIssue("lease_required", leaseRequiredMessage(runId)));
    } else {
      blockers.push(buildIssue("implementation_dispatch_not_implemented", implementationBoundaryMessage()));
    }
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      stepsTaken,
      blockers,
      warnings,
    });
  }

  if (["verification", "internal_review", "fix_loop", "pr_ready"].includes(current.state)) {
    blockers.push(buildIssue("stage_not_implemented", unsupportedStageMessage(current.state)));
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      stepsTaken,
      blockers,
      warnings,
    });
  }

  blockers.push(buildIssue("unsupported_state", `Run ${runId} is in unsupported state ${current.state}.`));
  return buildRunnerReport({
    registryRoot,
    runId,
    previousState,
    currentState: current.state,
    outcome: "blocked",
    stepsTaken,
    blockers,
    warnings,
  });
}
