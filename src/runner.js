/**
 * Local mission runner orchestration for staged Buran backend runs.
 *
 * Responsibility:
 * - advance a single run through the local state machine,
 * - record immutable artifacts for workspace prep, gate execution, and PR projection,
 * - enforce documented transition edges and resume semantics.
 *
 * Non-goals:
 * - no worker execution from the `running` state,
 * - no implicit lease acquisition without explicit workspace input,
 * - no transport-side writes outside the configured projection adapter path.
 *
 * Invariants / side effects:
 * - reads and mutates registry snapshots on disk,
 * - records gate/projection artifacts before state transitions,
 * - returns sanitized public reports when adapter errors surface.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
import { buildImplementationDispatchIntent, createUnavailableImplementationDispatchAdapter, executeImplementationDispatch } from "./implementation-dispatch.js";
import { executeInternalReviewGate } from "./internal-review-adapter.js";
import { acquireWorkspaceLease } from "./locks.js";
import { sanitizePublicReportForOutput } from "./observability.js";
import { buildRecordedPrProjection, createLocalPrProjectionAdapter } from "./pr-projection-adapter.js";
import { executeVerificationGate } from "./verification-adapter.js";
import { getRunPaths, readRunSnapshot, recordArtifact, recordGateResult, recordProjectionIntent, recordProjectionResult, transitionRun } from "./registry-store.js";
import { canonicalJson, nonEmptyString, sha256Hex } from "./utils.js";
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
  internalReview = null,
  fixLoop = null,
  projection = null,
  externalSideEffects = false,
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
    internal_review: internalReview,
    fix_loop: fixLoop,
    projection,
    external_side_effects: Boolean(externalSideEffects),
  };
}

function leaseRequiredMessage(runId) {
  return `Run ${runId} is waiting_for_lock. Acquire a local lease with buran lease acquire --run ${runId} --workspace-id <id> or rerun with --workspace-id.`;
}

function implementationBoundaryMessage() {
  return "Local mission runner recorded an implementation dispatch handoff but the implementation-harness adapter did not return completed implementation evidence.";
}

function unsupportedStageMessage(state) {
  return `Local mission runner skeleton does not execute ${state} adapters yet.`;
}

function verificationTransition(status) {
  if (status === "PASS") return "internal_review";
  if (status === "FAIL") return "fix_loop";
  return "blocked_needs_human";
}

function internalReviewTransition(status) {
  if (status === "PASS") return "pr_ready";
  if (status === "FAIL") return "fix_loop";
  return "blocked_needs_human";
}

function verificationTransitionReason(status) {
  if (status === "PASS") return "verification passed";
  if (status === "FAIL") return "verification failed inside approved scope";
  return "verification blocked on unsupported or unsafe surface";
}

function internalReviewTransitionReason(status) {
  if (status === "PASS") return "internal review passed";
  if (status === "FAIL") return "internal review failed inside approved scope";
  return "internal review blocked on unsupported or unsafe surface";
}

function projectionTransitionReason() {
  return "PR handoff recorded";
}

function projectionProblemCode(suffix) {
  return `pr_projection_${suffix}`;
}


const MAX_FIX_ATTEMPTS = 2;

function recordedFixAttemptArtifacts(snapshot) {
  const byPath = snapshot?.artifacts?.recorded?.by_path || {};
  return Object.values(byPath).filter((summary) => summary?.gate_name === "fix_attempt");
}

function fixAttemptCount(snapshot) {
  return recordedFixAttemptArtifacts(snapshot).filter((summary) => summary?.provenance?.kind === "fix-attempt-result").length;
}

function buildFixAttemptIntent(snapshot, { attempt, maxAttempts } = {}) {
  const intent = {
    schema_version: "fix-attempt-intent.v1",
    run_id: snapshot?.run_id || "",
    task_id: snapshot?.task_id || "",
    fix_attempt: attempt,
    max_fix_attempts: maxAttempts,
    state: snapshot?.state || "",
    execution_epoch: snapshot?.execution?.current_epoch || 0,
    packet_artifact: snapshot?.artifacts?.packet || null,
    workspace: {
      id: snapshot?.workspace?.id || "",
    },
    failed_gates: {
      verification: snapshot?.gates?.verification || null,
      internal_review: snapshot?.gates?.internal_review || null,
    },
    scope_boundary: "approved_packet_artifact",
    dispatch_boundary: "implementation-harness",
    rerun_required: ["verification", "internal_review"],
  };
  const dispatchIntentId = sha256Hex(canonicalJson(intent));
  return {
    intent: {
      ...intent,
      dispatch_intent_id: dispatchIntentId,
    },
    artifactPath: `artifacts/fix-loop/intent-${attempt}-${dispatchIntentId.slice(0, 16)}.json`,
  };
}

function sanitizeRunnerReportMessage(message) {
  const sanitized = sanitizePublicReportForOutput(nonEmptyString(message), []);
  return nonEmptyString(sanitized) || "Sensitive error details were redacted from the local runner report.";
}

function buildProjectionProblem(code, message, extra = {}) {
  return buildIssue(projectionProblemCode(code), sanitizeRunnerReportMessage(message), extra);
}

async function readRecordedArtifactJson(runDir, artifactRef) {
  const artifactPath = nonEmptyString(artifactRef?.path);
  if (!artifactPath) return null;
  try {
    const artifactText = await fs.readFile(path.join(runDir, artifactPath), "utf8");
    return JSON.parse(artifactText);
  } catch {
    return null;
  }
}

function hasFreshRecordedGate(snapshot, gateName) {
  const currentEpoch = snapshot?.execution?.current_epoch;
  const gate = snapshot?.gates?.[gateName];
  return Number.isSafeInteger(currentEpoch)
    && currentEpoch >= 1
    && gate?.current_epoch === currentEpoch
    && Number.isSafeInteger(gate?.current_attempt)
    && gate.current_attempt >= 1
    && ["PASS", "FAIL", "BLOCKED"].includes(gate?.status);
}

function gateArtifactProblemCode(gateName, suffix) {
  return `${gateName}_${suffix}`;
}

function gateDisplayName(gateName) {
  return gateName === "internal_review" ? "internal review" : gateName;
}

async function inspectRecordedGateArtifacts(runDir, snapshot, gateName) {
  const gate = snapshot?.gates?.[gateName];
  const artifactRefs = Array.isArray(gate?.artifact_refs)
    ? gate.artifact_refs
    : [];
  const gateLabel = gateDisplayName(gateName);

  if (artifactRefs.length === 0) {
    return {
      ok: false,
      problem: buildIssue(
        gateArtifactProblemCode(gateName, "artifact_missing"),
        `Recorded ${gateLabel} result cannot be resumed because no immutable ${gateLabel} artifact reference is available.`,
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
          gateArtifactProblemCode(gateName, "artifact_missing"),
          `Recorded ${gateLabel} result cannot be resumed because its artifact reference is incomplete.`,
        ),
      };
    }

    const summary = recordedArtifacts[artifactPath];
    if (!summary) {
      return {
        ok: false,
        problem: buildIssue(
          gateArtifactProblemCode(gateName, "artifact_missing"),
          `Recorded ${gateLabel} result cannot be resumed because artifact ${artifactPath} is missing from the immutable artifact ledger.`,
        ),
      };
    }
    if (summary.sha256 !== expectedSha256) {
      return {
        ok: false,
        problem: buildIssue(
          gateArtifactProblemCode(gateName, "artifact_corrupt"),
          `Recorded ${gateLabel} result cannot be resumed because artifact ${artifactPath} has a hash mismatch in the immutable ledger.`,
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
            gateArtifactProblemCode(gateName, "artifact_missing"),
            `Recorded ${gateLabel} result cannot be resumed because artifact ${artifactPath} is missing on disk.`,
          ),
        };
      }
      throw error;
    }

    if (sha256Hex(artifactContent) !== expectedSha256) {
      return {
        ok: false,
        problem: buildIssue(
          gateArtifactProblemCode(gateName, "artifact_corrupt"),
          `Recorded ${gateLabel} result cannot be resumed because artifact ${artifactPath} no longer matches its recorded hash.`,
        ),
      };
    }
  }

  return { ok: true, artifact_refs: artifactRefs };
}

/**
 * Executes or resumes the verification gate for runs already positioned in `verification`.
 *
 * @param {object} params
 * @param {string} params.registryRoot
 * @param {string} params.runId
 * @param {object} params.current Current run snapshot.
 * @param {string|null} params.previousState State observed before this runner invocation.
 * @param {object[]} params.stepsTaken Mutable step accumulator for the public runner report.
 * @param {object[]} params.blockers Mutable blocker accumulator for the public runner report.
 * @param {object[]} params.warnings Mutable warning accumulator for the public runner report.
 * @param {object|null} params.workspacePreparation Previously recorded workspace preparation report, when available.
 * @param {object|null} params.implementationDispatch Previously recorded implementation dispatch report, when available.
 * @param {() => Date} params.clock
 * @param {string} params.actor
 * @param {{runDir: string}} params.paths
 * @returns {Promise<object>} Runner report after resuming or executing verification and applying the documented transition edge.
 */
async function runVerificationStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, clock, actor, paths } = {}) {
  let verification = null;

  if (hasFreshRecordedGate(current, "verification")) {
    const artifactIntegrity = await inspectRecordedGateArtifacts(paths.runDir, current, "verification");
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

/**
 * Executes or resumes the internal review gate for runs already positioned in `internal_review`.
 *
 * @param {object} params
 * @param {string} params.registryRoot
 * @param {string} params.runId
 * @param {object} params.current Current run snapshot.
 * @param {string|null} params.previousState State observed before this runner invocation.
 * @param {object[]} params.stepsTaken Mutable step accumulator for the public runner report.
 * @param {object[]} params.blockers Mutable blocker accumulator for the public runner report.
 * @param {object[]} params.warnings Mutable warning accumulator for the public runner report.
 * @param {object|null} params.workspacePreparation Previously recorded workspace preparation report, when available.
 * @param {object|null} params.implementationDispatch Previously recorded implementation dispatch report, when available.
 * @param {object|null} params.verification Verification report already attached to this runner cycle, when available.
 * @param {() => Date} params.clock
 * @param {string} params.actor
 * @param {{runDir: string}} params.paths
 * @returns {Promise<object>} Runner report after resuming or executing internal review and applying the documented transition edge.
 */
async function runInternalReviewStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, clock, actor, paths } = {}) {
  let internalReview = null;

  if (hasFreshRecordedGate(current, "internal_review")) {
    const artifactIntegrity = await inspectRecordedGateArtifacts(paths.runDir, current, "internal_review");
    if (!artifactIntegrity.ok) {
      internalReview = {
        status: current.gates.internal_review.status,
        artifact_ref: current.gates.internal_review.artifact_refs?.[0] || null,
        artifact_refs: current.gates.internal_review.artifact_refs,
        artifact_record_status: "missing",
        gate_result_status: "stale_recorded_result",
        resumed_recorded_result: false,
        problem: artifactIntegrity.problem,
      };
      blockers.push(artifactIntegrity.problem);
      stepsTaken.push(buildStep({
        action: "internal_review_resume",
        status: "blocked",
        fromState: "internal_review",
        toState: "internal_review",
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
        internalReview,
      });
    }

    const targetState = internalReviewTransition(current.gates.internal_review.status);
    const artifactReport = await readRecordedArtifactJson(paths.runDir, artifactIntegrity.artifact_refs[0] || null);
    internalReview = {
      ...(artifactReport && typeof artifactReport === "object" && !Array.isArray(artifactReport) ? artifactReport : {}),
      status: current.gates.internal_review.status,
      artifact_ref: artifactIntegrity.artifact_refs[0] || null,
      artifact_refs: artifactIntegrity.artifact_refs,
      artifact_record_status: "noop",
      resumed_recorded_result: true,
      gate_result_status: "noop",
    };
    stepsTaken.push(buildStep({
      action: "internal_review_resume",
      status: "noop",
      fromState: "internal_review",
      toState: "internal_review",
      detail: "Existing current-epoch internal review gate result was reused without re-executing internal review.",
    }));

    const transitioned = await transitionRun(registryRoot, runId, {
      toState: targetState,
      actor,
      evidence: {
        reason: internalReviewTransitionReason(current.gates.internal_review.status),
        internal_review_gate: {
          status: current.gates.internal_review.status,
          execution_epoch: current.gates.internal_review.current_epoch,
          gate_attempt: current.gates.internal_review.current_attempt,
          artifact_refs: artifactIntegrity.artifact_refs,
          resumed_recorded_result: true,
          ...(artifactReport?.problem ? { problem: artifactReport.problem } : {}),
        },
      },
      clock,
    });
    current = transitioned.run;
    stepsTaken.push(buildStep({
      action: "transition",
      status: "completed",
      fromState: "internal_review",
      toState: current.state,
      detail: `Internal review status ${internalReview.status} advanced the run through the documented state-machine edge.`,
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
      internalReview,
    });
  }

  const internalReviewRun = await executeInternalReviewGate({
    runDir: paths.runDir,
    snapshot: current,
    clock,
  });

  const recordedArtifact = await recordArtifact(registryRoot, runId, {
    artifactPath: internalReviewRun.artifact_path,
    content: internalReviewRun.artifact_content,
    gate_name: "internal_review",
    execution_epoch: internalReviewRun.execution_epoch,
    gate_attempt: internalReviewRun.gate_attempt,
    recorded_from_state: "internal_review",
    actor: internalReviewRun.actor,
    recorded_at: internalReviewRun.recorded_at,
    provenance: internalReviewRun.provenance,
  });
  current = recordedArtifact.run;
  stepsTaken.push(buildStep({
    action: "internal_review_artifact",
    status: recordedArtifact.status === "noop" ? "noop" : "completed",
    fromState: "internal_review",
    toState: "internal_review",
    detail: `Internal review ${internalReviewRun.status} evidence was recorded under the immutable gate ledger.`,
    sequence: recordedArtifact.event?.sequence ?? null,
    artifactPath: recordedArtifact.artifact_ref.path,
    artifactSha256: recordedArtifact.artifact_ref.sha256,
  }));

  const gateResult = await recordGateResult(registryRoot, runId, {
    gate_name: "internal_review",
    execution_epoch: internalReviewRun.execution_epoch,
    gate_attempt: internalReviewRun.gate_attempt,
    recorded_from_state: "internal_review",
    status: internalReviewRun.status,
    artifact_refs: [recordedArtifact.artifact_ref],
    recorded_at: internalReviewRun.recorded_at,
    actor: internalReviewRun.actor,
    idempotency_key: internalReviewRun.idempotency_key,
  });
  current = gateResult.run;
  stepsTaken.push(buildStep({
    action: "gate_result_recorded",
    status: gateResult.status === "noop" ? "noop" : "completed",
    fromState: "internal_review",
    toState: "internal_review",
    detail: `Internal review gate result ${internalReviewRun.status} was recorded for the current epoch and attempt.`,
    sequence: gateResult.event?.sequence ?? null,
    artifactPath: recordedArtifact.artifact_ref.path,
    artifactSha256: recordedArtifact.artifact_ref.sha256,
  }));

  internalReview = {
    ...internalReviewRun.public_report,
    artifact_ref: recordedArtifact.artifact_ref,
    artifact_record_status: recordedArtifact.status,
    gate_result_status: gateResult.status,
    resumed_recorded_result: false,
  };

  const targetState = internalReviewTransition(internalReviewRun.status);
  const transitioned = await transitionRun(registryRoot, runId, {
    toState: targetState,
    actor,
    evidence: {
      reason: internalReviewTransitionReason(internalReviewRun.status),
      internal_review_gate: {
        adapter: internalReviewRun.adapter,
        status: internalReviewRun.status,
        execution_epoch: internalReviewRun.execution_epoch,
        gate_attempt: internalReviewRun.gate_attempt,
        artifact_ref: recordedArtifact.artifact_ref,
        ...(internalReviewRun.public_report?.problem ? { problem: internalReviewRun.public_report.problem } : {}),
      },
    },
    clock,
  });
  current = transitioned.run;
  stepsTaken.push(buildStep({
    action: "transition",
    status: "completed",
    fromState: "internal_review",
    toState: current.state,
    detail: `Internal review status ${internalReviewRun.status} advanced the run through the documented state-machine edge.`,
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
    internalReview,
  });
}

/**
 * Records PR projection intent/result for runs already positioned in `pr_ready`.
 *
 * @param {object} params
 * @param {string} params.registryRoot
 * @param {string} params.runId
 * @param {object} params.current Current run snapshot.
 * @param {string|null} params.previousState State observed before this runner invocation.
 * @param {object[]} params.stepsTaken Mutable step accumulator for the public runner report.
 * @param {object[]} params.blockers Mutable blocker accumulator for the public runner report.
 * @param {object[]} params.warnings Mutable warning accumulator for the public runner report.
 * @param {object|null} params.workspacePreparation Previously recorded workspace preparation report, when available.
 * @param {object|null} params.implementationDispatch Previously recorded implementation dispatch report, when available.
 * @param {object|null} params.verification Verification report already attached to this runner cycle, when available.
 * @param {object|null} params.internalReview Internal review report already attached to this runner cycle, when available.
 * @param {() => Date} params.clock
 * @param {string} params.actor
 * @param {{plan(snapshot: object, options?: object): object, execute(snapshot: object, plan: object, options?: object): Promise<object>, externalSideEffects?: boolean}} [params.prProjectionAdapter=createLocalPrProjectionAdapter()]
 * @returns {Promise<object>} Runner report after recording projection artifacts and transitioning to manual review.
 */
async function runPrReadyStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, internalReview, clock, actor, prProjectionAdapter = createLocalPrProjectionAdapter() } = {}) {
  let projection = null;
  let plannedProjection;
  let projectionExternalSideEffects = Boolean(prProjectionAdapter?.externalSideEffects);

  try {
    plannedProjection = prProjectionAdapter.plan(current, { clock, actor });
    projectionExternalSideEffects = Boolean(plannedProjection.externalSideEffects);
    const intentRecorded = await recordProjectionIntent(registryRoot, runId, {
      projection_name: plannedProjection.projectionName,
      projection_target: plannedProjection.projectionTarget,
      adapter: plannedProjection.adapter,
      mode: plannedProjection.mode,
      execution_epoch: plannedProjection.executionEpoch,
      recorded_from_state: "pr_ready",
      idempotency_key: plannedProjection.intentIdempotencyKey,
      artifactPath: plannedProjection.intentArtifactPath,
      content: plannedProjection.intentArtifactContent,
      actor: plannedProjection.actor,
      recorded_at: plannedProjection.recordedAt,
    });
    current = intentRecorded.run;
    stepsTaken.push(buildStep({
      action: "projection_intent_recorded",
      status: intentRecorded.status === "noop" ? "noop" : "completed",
      fromState: "pr_ready",
      toState: "pr_ready",
      detail: projectionExternalSideEffects
        ? "PR projection intent was recorded locally before the transport-backed handoff."
        : "PR projection intent was recorded locally without a remote GitHub write.",
      sequence: intentRecorded.event?.sequence ?? null,
      artifactPath: intentRecorded.artifact_ref.path,
      artifactSha256: intentRecorded.artifact_ref.sha256,
    }));

    const resumedProjection = buildRecordedPrProjection(current, {
      clock,
      expectedAdapter: plannedProjection.adapter,
      expectedMode: plannedProjection.mode,
      externalSideEffects: projectionExternalSideEffects,
    });
    if (resumedProjection && resumedProjection.resultIdempotencyKey === plannedProjection.resultIdempotencyKey) {
      plannedProjection = resumedProjection;
    } else {
      plannedProjection = await prProjectionAdapter.execute(current, plannedProjection, { clock, actor });
      projectionExternalSideEffects = Boolean(plannedProjection.externalSideEffects);
    }

    const resultRecorded = await recordProjectionResult(registryRoot, runId, {
      projection_name: plannedProjection.projectionName,
      projection_target: plannedProjection.projectionTarget,
      adapter: plannedProjection.adapter,
      mode: plannedProjection.mode,
      execution_epoch: plannedProjection.executionEpoch,
      recorded_from_state: "pr_ready",
      idempotency_key: plannedProjection.resultIdempotencyKey,
      intent_idempotency_key: plannedProjection.intentIdempotencyKey,
      status: plannedProjection.result.status,
      github_pr: plannedProjection.githubPr,
      artifactPath: plannedProjection.resultArtifactPath,
      content: plannedProjection.resultArtifactContent,
      actor: plannedProjection.actor,
      recorded_at: plannedProjection.recordedAt,
    });
    current = resultRecorded.run;
    projection = {
      ...plannedProjection.publicReport,
      intent_artifact_ref: intentRecorded.artifact_ref,
      result_artifact_ref: resultRecorded.artifact_ref,
      intent_record_status: intentRecorded.status,
      result_record_status: resultRecorded.status,
    };
    stepsTaken.push(buildStep({
      action: "projection_result_recorded",
      status: resultRecorded.status === "noop" ? "noop" : "completed",
      fromState: "pr_ready",
      toState: "pr_ready",
      detail: projectionExternalSideEffects
        ? "PR projection result was recorded locally after the transport-backed PR handoff."
        : "PR projection result was recorded locally and mirrored into github.pr without a remote GitHub write.",
      sequence: resultRecorded.event?.sequence ?? null,
      artifactPath: resultRecorded.artifact_ref.path,
      artifactSha256: resultRecorded.artifact_ref.sha256,
    }));
  } catch (error) {
    const message = sanitizeRunnerReportMessage(error?.message || String(error));
    const problem = error?.code === "projection_missing_base_branch"
      ? buildProjectionProblem("missing_base_branch", message)
      : error?.code === "projection_invalid_transport_status" || error?.code === "projection_invalid_transport_result" || error?.code === "projection_invalid_github_pr"
      ? buildProjectionProblem("invalid_transport_result", message)
      : /different hash/i.test(message)
      ? buildProjectionProblem("artifact_corrupt", `Recorded PR projection cannot be resumed because its local artifact is corrupt: ${message}`)
      : buildProjectionProblem("record_failed", `PR projection handoff could not be recorded locally: ${message}`);
    projection = {
      ...(plannedProjection?.publicReport || {
        status: "blocked",
        adapter: prProjectionAdapter?.adapter || "local-github-pr-projection",
        mode: prProjectionAdapter?.mode || "local_fake",
      }),
      intent_record_status: "blocked",
      result_record_status: "blocked",
      problem,
    };
    blockers.push(problem);
    stepsTaken.push(buildStep({
      action: "projection_result_recorded",
      status: "blocked",
      fromState: "pr_ready",
      toState: "pr_ready",
      detail: problem.message,
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
      internalReview,
      projection,
      externalSideEffects: projectionExternalSideEffects,
    });
  }

  const transitioned = await transitionRun(registryRoot, runId, {
    toState: "ready_for_manual_review",
    actor,
    evidence: {
      reason: projectionTransitionReason(),
      pr_projection: {
        adapter: plannedProjection.adapter,
        mode: plannedProjection.mode,
        execution_epoch: plannedProjection.executionEpoch,
        intent_idempotency_key: plannedProjection.intentIdempotencyKey,
        result_idempotency_key: plannedProjection.resultIdempotencyKey,
        github_pr: plannedProjection.githubPr,
        result_artifact_ref: projection.result_artifact_ref,
      },
    },
    clock,
  });
  current = transitioned.run;
  stepsTaken.push(buildStep({
    action: "transition",
    status: "completed",
    fromState: "pr_ready",
    toState: current.state,
    detail: "Recorded PR projection handoff advanced the run to ready_for_manual_review.",
    sequence: transitioned.event.sequence,
    artifactPath: projection.result_artifact_ref.path,
    artifactSha256: projection.result_artifact_ref.sha256,
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
    internalReview,
    projection,
    externalSideEffects: projectionExternalSideEffects,
  });
}


/**
 * Executes one bounded implementation-harness fix attempt, then returns the run to verification.
 */
async function runFixLoopStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, internalReview, clock, actor, implementationDispatchAdapter } = {}) {
  const completedAttempts = fixAttemptCount(current);
  if (completedAttempts >= MAX_FIX_ATTEMPTS) {
    const problem = buildIssue("fix_attempts_exhausted", `Fix loop stopped after ${completedAttempts} completed attempt${completedAttempts === 1 ? "" : "s"}; maximum is ${MAX_FIX_ATTEMPTS}.`);
    blockers.push(problem);
    const transitioned = await transitionRun(registryRoot, runId, {
      toState: "blocked_needs_human",
      actor,
      evidence: {
        reason: "fix envelope exceeded",
        terminal_reason: problem.message,
        fix_loop: {
          completed_attempts: completedAttempts,
          max_attempts: MAX_FIX_ATTEMPTS,
        },
      },
      clock,
    });
    current = transitioned.run;
    stepsTaken.push(buildStep({
      action: "fix_loop_bounds",
      status: "blocked",
      fromState: "fix_loop",
      toState: current.state,
      detail: problem.message,
      sequence: transitioned.event.sequence,
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
      internalReview,
    });
  }

  if (!hasActiveLease(current)) {
    const problem = buildIssue("lease_required", "Fix loop requires the active workspace lease from the failed verification/review epoch.");
    blockers.push(problem);
    stepsTaken.push(buildStep({
      action: "fix_loop_dispatch",
      status: "blocked",
      fromState: "fix_loop",
      toState: "fix_loop",
      detail: problem.message,
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
      internalReview,
    });
  }

  const attempt = completedAttempts + 1;
  const fixIntent = buildFixAttemptIntent(current, {
    attempt,
    maxAttempts: MAX_FIX_ATTEMPTS,
  });
  const recordedAt = clock().toISOString();
  const intentRecorded = await recordArtifact(registryRoot, runId, {
    artifactPath: fixIntent.artifactPath,
    content: `${JSON.stringify(fixIntent.intent, null, 2)}\n`,
    gate_name: "fix_attempt",
    execution_epoch: current.execution?.current_epoch || 0,
    gate_attempt: 1,
    recorded_from_state: "fix_loop",
    actor,
    recorded_at: recordedAt,
    provenance: {
      kind: "fix-attempt-intent",
      fix_attempt: attempt,
      max_fix_attempts: MAX_FIX_ATTEMPTS,
      failed_gates: fixIntent.intent.failed_gates,
    },
  });
  current = intentRecorded.run;
  stepsTaken.push(buildStep({
    action: "fix_attempt_intent",
    status: intentRecorded.status === "noop" ? "noop" : "completed",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: `Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS} intent was recorded before implementation-harness dispatch.`,
    sequence: intentRecorded.event?.sequence ?? null,
    artifactPath: intentRecorded.artifact_ref.path,
    artifactSha256: intentRecorded.artifact_ref.sha256,
  }));

  const dispatchResult = await executeImplementationDispatch({
    snapshot: current,
    intent: fixIntent.intent,
    adapter: implementationDispatchAdapter,
    clock,
  });
  const resultRecorded = await recordArtifact(registryRoot, runId, {
    artifactPath: dispatchResult.artifact_path,
    content: dispatchResult.artifact_content,
    gate_name: "fix_attempt",
    execution_epoch: current.execution?.current_epoch || 0,
    gate_attempt: 1,
    recorded_from_state: "fix_loop",
    actor: dispatchResult.actor,
    recorded_at: dispatchResult.recorded_at,
    provenance: {
      kind: "fix-attempt-result",
      adapter: dispatchResult.adapter,
      status: dispatchResult.status,
      fix_attempt: attempt,
      intent_artifact: intentRecorded.artifact_ref,
    },
  });
  current = resultRecorded.run;
  implementationDispatch = {
    ...dispatchResult.public_report,
    fix_attempt: attempt,
    max_fix_attempts: MAX_FIX_ATTEMPTS,
    intent_artifact_ref: intentRecorded.artifact_ref,
    result_artifact_ref: resultRecorded.artifact_ref,
    intent_record_status: intentRecorded.status,
    result_record_status: resultRecorded.status,
  };
  stepsTaken.push(buildStep({
    action: "fix_attempt_result",
    status: resultRecorded.status === "noop" ? "noop" : dispatchResult.status === "COMPLETED" ? "completed" : "blocked",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: dispatchResult.public_report.summary || implementationBoundaryMessage(),
    sequence: resultRecorded.event?.sequence ?? null,
    artifactPath: resultRecorded.artifact_ref.path,
    artifactSha256: resultRecorded.artifact_ref.sha256,
  }));

  if (dispatchResult.status !== "COMPLETED") {
    blockers.push(buildIssue("fix_attempt_blocked", implementationBoundaryMessage(), {
      fix_attempt: attempt,
      max_fix_attempts: MAX_FIX_ATTEMPTS,
      dispatch_status: dispatchResult.status,
      problem: dispatchResult.public_report?.problem || null,
      intent_artifact_ref: intentRecorded.artifact_ref,
      result_artifact_ref: resultRecorded.artifact_ref,
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
      internalReview,
    });
  }

  const transitioned = await transitionRun(registryRoot, runId, {
    toState: "verification",
    actor,
    evidence: {
      reason: "fixes applied",
      fix_loop: {
        fix_attempt: attempt,
        max_fix_attempts: MAX_FIX_ATTEMPTS,
        intent_artifact_ref: intentRecorded.artifact_ref,
        result_artifact_ref: resultRecorded.artifact_ref,
      },
    },
    clock,
  });
  current = transitioned.run;
  stepsTaken.push(buildStep({
    action: "transition",
    status: "completed",
    fromState: "fix_loop",
    toState: current.state,
    detail: "Completed fix attempt advanced the run to a fresh verification epoch.",
    sequence: transitioned.event.sequence,
    artifactPath: resultRecorded.artifact_ref.path,
    artifactSha256: resultRecorded.artifact_ref.sha256,
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
    internalReview,
  });
}

/**
 * Runs the local orchestration slice for a single registry run.
 *
 * The runner owns state advancement, artifact recording, and adapter invocation for
 * verification, internal review, and PR projection. It intentionally blocks in
 * `running` after recording workspace preparation and implementation dispatch, because
 * worker execution belongs to a separate boundary.
 *
 * @param {object} params
 * @param {string} params.registryRoot Absolute registry root that stores run snapshots.
 * @param {string} params.runId Run identifier to load and advance.
 * @param {string} [params.workspaceId=""] Workspace lease identifier required when the run is waiting for lock acquisition.
 * @param {string} [params.workspacePath=""] Optional leased workspace path recorded with the lock.
 * @param {string|number} [params.ttlMs=""] Optional lease TTL forwarded to lease acquisition.
 * @param {() => Date} [params.clock=() => new Date()] Clock source used for artifact timestamps and transitions.
 * @param {string} [params.actor=RUNNER_ACTOR] Actor name recorded on state transitions and artifacts.
 * @param {{plan(snapshot: object, options?: object): object, execute(snapshot: object, plan: object, options?: object): Promise<object>, externalSideEffects?: boolean}} [params.prProjectionAdapter=createLocalPrProjectionAdapter()]
 * Projection adapter used when the run reaches `pr_ready`.
 * @returns {Promise<object>} Sanitized public runner report describing completed work, blockers, and current state.
 * @throws {Error} When required identifiers are missing or an unexpected storage/adapter error occurs.
 */
export async function runLocalMission({ registryRoot, runId, workspaceId = "", workspacePath = "", ttlMs = "", clock = () => new Date(), actor = RUNNER_ACTOR, implementationDispatchAdapter = createUnavailableImplementationDispatchAdapter(), prProjectionAdapter = createLocalPrProjectionAdapter() } = {}) {
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
  let internalReview = null;
  let fixLoop = null;

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
      internalReview,
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
      internalReview,
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
        internalReview,
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
        internalReview,
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
        stepsTaken.push(buildStep({
          action: "implementation_dispatch_intent",
          status: dispatchRecorded.status === "noop" ? "noop" : "completed",
          fromState: "running",
          toState: "running",
          detail: "Implementation-harness dispatch intent was recorded locally before adapter execution.",
          sequence: dispatchRecorded.event?.sequence ?? null,
          workspaceId: current.workspace?.id || "",
          artifactPath: dispatchRecorded.artifact_ref.path,
          artifactSha256: dispatchRecorded.artifact_ref.sha256,
        }));

        const dispatchResult = await executeImplementationDispatch({
          snapshot: current,
          intent: dispatchIntent.intent,
          adapter: implementationDispatchAdapter,
          clock,
        });
        const dispatchResultRecorded = await recordArtifact(registryRoot, runId, {
          artifactPath: dispatchResult.artifact_path,
          content: dispatchResult.artifact_content,
          gate_name: "implementation_dispatch",
          execution_epoch: current.execution?.current_epoch || 0,
          gate_attempt: 1,
          recorded_from_state: "running",
          actor: dispatchResult.actor,
          recorded_at: dispatchResult.recorded_at,
          provenance: dispatchResult.provenance,
        });
        current = dispatchResultRecorded.run;
        implementationDispatch = {
          ...dispatchResult.public_report,
          intent_artifact_ref: dispatchRecorded.artifact_ref,
          result_artifact_ref: dispatchResultRecorded.artifact_ref,
          intent_record_status: dispatchRecorded.status,
          result_record_status: dispatchResultRecorded.status,
          workspace_preparation_artifact_ref: recorded.artifact_ref,
        };
        stepsTaken.push(buildStep({
          action: "implementation_dispatch_result",
          status: dispatchResultRecorded.status === "noop" ? "noop" : dispatchResult.status === "COMPLETED" ? "completed" : "blocked",
          fromState: "running",
          toState: "running",
          detail: dispatchResult.public_report.summary || implementationBoundaryMessage(),
          sequence: dispatchResultRecorded.event?.sequence ?? null,
          workspaceId: current.workspace?.id || "",
          artifactPath: dispatchResultRecorded.artifact_ref.path,
          artifactSha256: dispatchResultRecorded.artifact_ref.sha256,
        }));

        warnings.push(...inspected.warnings);
        if (dispatchResult.status === "COMPLETED") {
          const transitioned = await transitionRun(registryRoot, runId, {
            toState: "verification",
            actor,
            evidence: {
              reason: "implementation completed",
              implementation_dispatch: {
                adapter: dispatchResult.adapter,
                status: dispatchResult.status,
                intent_artifact_ref: dispatchRecorded.artifact_ref,
                result_artifact_ref: dispatchResultRecorded.artifact_ref,
              },
            },
            clock,
          });
          current = transitioned.run;
          stepsTaken.push(buildStep({
            action: "transition",
            status: "completed",
            fromState: "running",
            toState: current.state,
            detail: "Completed implementation-harness dispatch advanced the run to verification.",
            sequence: transitioned.event.sequence,
            artifactPath: dispatchResultRecorded.artifact_ref.path,
            artifactSha256: dispatchResultRecorded.artifact_ref.sha256,
          }));
        } else {
          blockers.push(buildIssue("implementation_dispatch_blocked", implementationBoundaryMessage(), {
            dispatch_status: implementationDispatch.status,
            problem: implementationDispatch.problem || null,
            intent_artifact_ref: implementationDispatch.intent_artifact_ref,
            result_artifact_ref: implementationDispatch.result_artifact_ref,
          }));
        }
      }
    }

    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: blockers.length > 0 ? "blocked" : "completed",
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
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

  if (current.state === "internal_review") {
    return runInternalReviewStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      clock,
      actor,
      paths,
    });
  }

  if (current.state === "pr_ready") {
    return runPrReadyStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      clock,
      actor,
      prProjectionAdapter,
    });
  }

  if (current.state === "fix_loop") {
    return runFixLoopStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      clock,
      actor,
      implementationDispatchAdapter,
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
    internalReview,
  });
}
