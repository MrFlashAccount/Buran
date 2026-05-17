import { promises as fs } from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
import { buildImplementationDispatchIntent } from "./implementation-dispatch.js";
import { acquireWorkspaceLease } from "./locks.js";
import { executeVerificationGate } from "./verification-adapter.js";
import { getRunPaths, readRunSnapshot, recordArtifact, recordGateResult, transitionRun } from "./registry-store.js";
import { nonEmptyString, sha256Hex } from "./utils.js";
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
  verification = null,
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
    verification,
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

function verificationTransition(status) {
  if (status === "PASS") return "internal_review";
  if (status === "FAIL") return "fix_loop";
  return "blocked_needs_human";
}

function verificationTransitionReason(status) {
  if (status === "PASS") return "verification passed";
  if (status === "FAIL") return "verification failed inside approved scope";
  return "verification blocked on unsupported or unsafe surface";
}

function hasFreshRecordedVerification(snapshot) {
  const currentEpoch = snapshot?.execution?.current_epoch;
  const gate = snapshot?.gates?.verification;
  return Number.isSafeInteger(currentEpoch)
    && currentEpoch >= 1
    && gate?.current_epoch === currentEpoch
    && Number.isSafeInteger(gate?.current_attempt)
    && gate.current_attempt >= 1
    && ["PASS", "FAIL", "BLOCKED"].includes(gate?.status);
}

async function inspectRecordedVerificationArtifacts(runDir, snapshot) {
  const artifactRefs = Array.isArray(snapshot?.gates?.verification?.artifact_refs)
    ? snapshot.gates.verification.artifact_refs
    : [];
  if (artifactRefs.length === 0) {
    return {
      ok: false,
      problem: buildIssue(
        "verification_artifact_missing",
        "Recorded verification result cannot be resumed because no immutable verification artifact reference is available.",
      ),
    };
  }

  const recordedArtifacts = snapshot?.artifacts?.recorded?.by_path || {};
  for (const artifactRef of artifactRefs) {
    const artifactPath = nonEmptyString(artifactRef?.path);
    const expectedSha256 = nonEmptyString(artifactRef?.sha256);
    if (!artifactPath || !expectedSha256) {
      return {
        ok: false,
        problem: buildIssue(
          "verification_artifact_missing",
          "Recorded verification result cannot be resumed because its artifact reference is incomplete.",
        ),
      };
    }

    const summary = recordedArtifacts[artifactPath];
    if (!summary) {
      return {
        ok: false,
        problem: buildIssue(
          "verification_artifact_missing",
          `Recorded verification result cannot be resumed because artifact ${artifactPath} is missing from the immutable artifact ledger.`,
        ),
      };
    }
    if (summary.sha256 !== expectedSha256) {
      return {
        ok: false,
        problem: buildIssue(
          "verification_artifact_corrupt",
          `Recorded verification result cannot be resumed because artifact ${artifactPath} has a hash mismatch in the immutable ledger.`,
        ),
      };
    }

    const absoluteArtifactPath = path.join(runDir, artifactPath);
    let artifactContent;
    try {
      artifactContent = await fs.readFile(absoluteArtifactPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          ok: false,
          problem: buildIssue(
            "verification_artifact_missing",
            `Recorded verification result cannot be resumed because artifact ${artifactPath} is missing on disk.`,
          ),
        };
      }
      throw error;
    }

    if (sha256Hex(artifactContent) !== expectedSha256) {
      return {
        ok: false,
        problem: buildIssue(
          "verification_artifact_corrupt",
          `Recorded verification result cannot be resumed because artifact ${artifactPath} no longer matches its recorded hash.`,
        ),
      };
    }
  }

  return { ok: true, artifact_refs: artifactRefs };
}

async function runVerificationStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, clock, actor, paths } = {}) {
  let verification = null;

  if (hasFreshRecordedVerification(current)) {
    const artifactIntegrity = await inspectRecordedVerificationArtifacts(paths.runDir, current);
    if (!artifactIntegrity.ok) {
      verification = {
        status: current.gates.verification.status,
        artifact_ref: current.gates.verification.artifact_refs?.[0] || null,
        artifact_refs: current.gates.verification.artifact_refs,
        artifact_record_status: "missing",
        gate_result_status: "stale_recorded_result",
        resumed_recorded_result: false,
        problem: artifactIntegrity.problem,
      };
      blockers.push(artifactIntegrity.problem);
      stepsTaken.push(buildStep({
        action: "verification_resume",
        status: "blocked",
        fromState: "verification",
        toState: "verification",
        detail: artifactIntegrity.problem.message,
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
        verification,
      });
    }

    const targetState = verificationTransition(current.gates.verification.status);
    verification = {
      status: current.gates.verification.status,
      artifact_ref: artifactIntegrity.artifact_refs[0] || null,
      artifact_refs: artifactIntegrity.artifact_refs,
      artifact_record_status: "noop",
      resumed_recorded_result: true,
      gate_result_status: "noop",
    };
    stepsTaken.push(buildStep({
      action: "verification_resume",
      status: "noop",
      fromState: "verification",
      toState: "verification",
      detail: "Existing current-epoch verification gate result was reused without re-executing verification.",
    }));

    const transitioned = await transitionRun(registryRoot, runId, {
      toState: targetState,
      actor,
      evidence: {
        reason: verificationTransitionReason(current.gates.verification.status),
        verification_gate: {
          status: current.gates.verification.status,
          execution_epoch: current.gates.verification.current_epoch,
          gate_attempt: current.gates.verification.current_attempt,
          artifact_refs: artifactIntegrity.artifact_refs,
          resumed_recorded_result: true,
        },
      },
      clock,
    });
    current = transitioned.run;
    stepsTaken.push(buildStep({
      action: "transition",
      status: "completed",
      fromState: "verification",
      toState: current.state,
      detail: `Verification status ${verification.status} advanced the run through the documented state-machine edge.`,
      sequence: transitioned.event.sequence,
    }));

    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "completed",
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
    });
  }

  const verificationRun = await executeVerificationGate({
    runDir: paths.runDir,
    snapshot: current,
    clock,
  });

  const recordedArtifact = await recordArtifact(registryRoot, runId, {
    artifactPath: verificationRun.artifact_path,
    content: verificationRun.artifact_content,
    gate_name: "verification",
    execution_epoch: verificationRun.execution_epoch,
    gate_attempt: verificationRun.gate_attempt,
    recorded_from_state: "verification",
    actor: verificationRun.actor,
    recorded_at: verificationRun.recorded_at,
    provenance: verificationRun.provenance,
  });
  current = recordedArtifact.run;
  stepsTaken.push(buildStep({
    action: "verification_artifact",
    status: recordedArtifact.status === "noop" ? "noop" : "completed",
    fromState: "verification",
    toState: "verification",
    detail: `Verification ${verificationRun.status} evidence was recorded under the immutable gate ledger.`,
    sequence: recordedArtifact.event?.sequence ?? null,
    artifactPath: recordedArtifact.artifact_ref.path,
    artifactSha256: recordedArtifact.artifact_ref.sha256,
  }));

  const gateResult = await recordGateResult(registryRoot, runId, {
    gate_name: "verification",
    execution_epoch: verificationRun.execution_epoch,
    gate_attempt: verificationRun.gate_attempt,
    recorded_from_state: "verification",
    status: verificationRun.status,
    artifact_refs: [recordedArtifact.artifact_ref],
    recorded_at: verificationRun.recorded_at,
    actor: verificationRun.actor,
    idempotency_key: verificationRun.idempotency_key,
  });
  current = gateResult.run;
  stepsTaken.push(buildStep({
    action: "gate_result_recorded",
    status: gateResult.status === "noop" ? "noop" : "completed",
    fromState: "verification",
    toState: "verification",
    detail: `Verification gate result ${verificationRun.status} was recorded for the current epoch and attempt.`,
    sequence: gateResult.event?.sequence ?? null,
    artifactPath: recordedArtifact.artifact_ref.path,
    artifactSha256: recordedArtifact.artifact_ref.sha256,
  }));

  verification = {
    ...verificationRun.public_report,
    artifact_ref: recordedArtifact.artifact_ref,
    artifact_record_status: recordedArtifact.status,
    gate_result_status: gateResult.status,
    resumed_recorded_result: false,
  };

  const targetState = verificationTransition(verificationRun.status);
  const transitioned = await transitionRun(registryRoot, runId, {
    toState: targetState,
    actor,
    evidence: {
      reason: verificationTransitionReason(verificationRun.status),
      verification_gate: {
        adapter: verificationRun.adapter,
        status: verificationRun.status,
        execution_epoch: verificationRun.execution_epoch,
        gate_attempt: verificationRun.gate_attempt,
        artifact_ref: recordedArtifact.artifact_ref,
      },
    },
    clock,
  });
  current = transitioned.run;
  stepsTaken.push(buildStep({
    action: "transition",
    status: "completed",
    fromState: "verification",
    toState: current.state,
    detail: `Verification status ${verificationRun.status} advanced the run through the documented state-machine edge.`,
    sequence: transitioned.event.sequence,
    artifactPath: recordedArtifact.artifact_ref.path,
    artifactSha256: recordedArtifact.artifact_ref.sha256,
  }));

  return buildRunnerReport({
    registryRoot,
    runId,
    previousState,
    currentState: current.state,
    outcome: "completed",
    stepsTaken,
    blockers,
    warnings,
    workspacePreparation,
    implementationDispatch,
    verification,
  });
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
  let verification = null;

  if (TERMINAL_STATES.has(current.state)) {
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      workspacePreparation,
      implementationDispatch,
      verification,
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
      verification,
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
        verification,
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
        verification,
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
      verification,
    });
  }

  if (current.state === "verification") {
    return runVerificationStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      clock,
      actor,
      paths,
    });
  }

  if (["internal_review", "fix_loop", "pr_ready"].includes(current.state)) {
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
      verification,
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
    verification,
  });
}
