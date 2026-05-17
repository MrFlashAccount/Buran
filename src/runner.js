import { SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
import { buildImplementationDispatchIntent } from "./implementation-dispatch.js";
import { acquireWorkspaceLease } from "./locks.js";
import { getRunPaths, readRunSnapshot, recordArtifact, transitionRun } from "./registry-store.js";
import { nonEmptyString } from "./utils.js";
import { inspectWorkspacePreparation } from "./workspace-preparation.js";

const RUNNER_MODE = "run_local";
const RUNNER_ACTOR = "local-mission-runner";

function hasActiveLease(snapshot) {
  return snapshot?.workspace?.lease_status === "acquired" || snapshot?.locks?.lease_status === "acquired";
}

function buildStep({ action, status, fromState = "", toState = "", detail = "", sequence = null, workspaceId = "", leaseId = "", expiresAt = "", conflicts = 0, rolledBackRecords = 0, artifactPath = "", artifactSha256 = "" } = {}) {
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
  if (artifactPath) step.artifact_path = artifactPath;
  if (artifactSha256) step.artifact_sha256 = artifactSha256;
  return step;
}

function buildIssue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function buildRunnerReport({
  registryRoot,
  runId,
  previousState = null,
  currentState = null,
  outcome,
  stepsTaken = [],
  blockers = [],
  warnings = [],
  workspacePreparation = null,
  implementationDispatch = null,
} = {}) {
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
    workspace_preparation: workspacePreparation,
    implementation_dispatch: implementationDispatch,
    external_side_effects: false,
  };
}

function leaseRequiredMessage(runId) {
  return `Run ${runId} is waiting_for_lock. Acquire a local lease with buran lease acquire --run ${runId} --workspace-id <id> or rerun with --workspace-id.`;
}

function implementationBoundaryMessage() {
  return "Local mission runner recorded an implementation dispatch handoff but stops before worker execution. This current local runner slice does not start workers, verification, review, or external writes.";
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
  let workspacePreparation = null;
  let implementationDispatch = null;

  if (TERMINAL_STATES.has(current.state)) {
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      workspacePreparation,
      implementationDispatch,
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
      workspacePreparation,
      implementationDispatch,
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
        workspacePreparation,
        implementationDispatch,
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
        workspacePreparation,
        implementationDispatch,
      });
    }
  }

  if (current.state === "running") {
    if (!hasActiveLease(current)) {
      warnings.push(buildIssue("lease_not_active", `Run ${runId} is in running without an active local lease snapshot.`));
      blockers.push(buildIssue("lease_required", leaseRequiredMessage(runId)));
    } else {
      const inspected = await inspectWorkspacePreparation(current.workspace?.path || "", {
        intendedBranch: current.github?.intended_branch || "",
      });

      if (!inspected.ok) {
        workspacePreparation = {
          status: "blocked",
          artifact_ref: null,
          artifact_record_status: "not_recorded",
          blocker: inspected.blocker,
          warnings: inspected.warnings || [],
        };
        blockers.push(inspected.blocker);
        warnings.push(...(inspected.warnings || []));
    } else {
      const recordedAt = clock().toISOString();
      const recorded = await recordArtifact(registryRoot, runId, {
        artifactPath: inspected.artifact_path,
        content: inspected.content,
          gate_name: "workspace_preparation",
          execution_epoch: current.execution?.current_epoch || 0,
          gate_attempt: 1,
          recorded_from_state: "running",
          actor,
          recorded_at: recordedAt,
          provenance: {
            kind: "workspace-preparation-report",
            workspace_id: current.workspace?.id || "",
            workspace_snapshot_id: inspected.report.workspace_snapshot_id,
          },
        });
        current = recorded.run;
        workspacePreparation = {
          status: inspected.preparation_status,
          artifact_ref: recorded.artifact_ref,
          artifact_record_status: recorded.status,
          blocker: null,
          warnings: inspected.warnings,
        };
        stepsTaken.push(buildStep({
          action: "workspace_preparation",
          status: recorded.status === "noop" ? "noop" : "completed",
          fromState: "running",
          toState: "running",
          detail: "Local workspace intent was inspected and recorded without creating a branch, checkout, or worktree.",
          sequence: recorded.event?.sequence ?? null,
          workspaceId: current.workspace?.id || "",
          artifactPath: recorded.artifact_ref.path,
          artifactSha256: recorded.artifact_ref.sha256,
        }));

        const dispatchIntent = buildImplementationDispatchIntent(current, {
          workspacePreparationArtifactRef: recorded.artifact_ref,
        });
        const dispatchRecorded = await recordArtifact(registryRoot, runId, {
          artifactPath: dispatchIntent.artifactPath,
          content: `${JSON.stringify(dispatchIntent.intent, null, 2)}\n`,
          gate_name: "implementation_dispatch",
          execution_epoch: current.execution?.current_epoch || 0,
          gate_attempt: 1,
          recorded_from_state: "running",
          actor,
          recorded_at: recordedAt,
          provenance: {
            kind: "implementation-dispatch-intent",
            workspace_preparation_artifact: recorded.artifact_ref,
            packet_artifact: current.artifacts?.packet || null,
            dispatch_intent_id: dispatchIntent.intent.dispatch_intent_id,
          },
        });
        current = dispatchRecorded.run;
        implementationDispatch = {
          status: "dispatch_ready_not_started",
          artifact_ref: dispatchRecorded.artifact_ref,
          artifact_record_status: dispatchRecorded.status,
          blocker: null,
          workspace_preparation_artifact_ref: recorded.artifact_ref,
        };
        stepsTaken.push(buildStep({
          action: "implementation_dispatch",
          status: dispatchRecorded.status === "noop" ? "noop" : "completed",
          fromState: "running",
          toState: "running",
          detail: "Implementation dispatch handoff was recorded locally without starting a worker.",
          sequence: dispatchRecorded.event?.sequence ?? null,
          workspaceId: current.workspace?.id || "",
          artifactPath: dispatchRecorded.artifact_ref.path,
          artifactSha256: dispatchRecorded.artifact_ref.sha256,
        }));

        warnings.push(...inspected.warnings);
        blockers.push(buildIssue("implementation_dispatch_not_implemented", implementationBoundaryMessage(), {
          dispatch_status: implementationDispatch.status,
          handoff_artifact_ref: implementationDispatch.artifact_ref,
        }));
      }
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
      workspacePreparation,
      implementationDispatch,
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
      workspacePreparation,
      implementationDispatch,
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
    workspacePreparation,
    implementationDispatch,
  });
}
