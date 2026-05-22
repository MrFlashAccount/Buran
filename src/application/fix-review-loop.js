/** Fix/review retry-loop coordination for local mission orchestration. */
import { promises as fs } from "node:fs";
import path from "node:path";

import { TERMINAL_STATES } from "../core/modules/execution-runs/constants.js";
import { IMPLEMENTATION_DISPATCH_ADAPTER, buildImplementationDispatchIntent, executeImplementationDispatch, implementationDispatchStatusSummary, isUnavailableImplementationDispatchResult, sanitizeImplementationDispatchEvidence, validateImplementationDispatchResultReport } from "../gates/implementation-contract.js";
import { executeInternalReviewGate, sanitizeRecordedInternalReviewReport } from "../gates/internal-review-adapter.js";
import { sanitizePublicReportForOutput } from "../observability/index.js";
import { buildRecordedScmHandoff } from "../core/modules/scm-handoff/services/scm-handoff-projection.js";
import { executeVerificationGate } from "../gates/verification-adapter.js";
import { evaluateReviewReadyPolicy } from "../stack-workflow/review-ready-policy.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";
import { hasActiveLease } from "./mission-context.js";
import { buildIssue, buildRunnerReport, buildStep, implementationBoundaryMessage, internalReviewTransition, internalReviewTransitionReason, leaseRequiredMessage, projectionProblemCode, projectionTransitionReason, sanitizeImplementationDispatchProblem, unsupportedStageMessage, verificationTransition, verificationTransitionReason } from "./final-report.js";

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

function fixAttemptResultArtifactSummary(snapshot) {
  const currentEpoch = snapshot?.execution?.current_epoch;
  if (!Number.isSafeInteger(currentEpoch)) return null;
  return recordedFixAttemptArtifacts(snapshot)
    .filter((summary) => summary?.recorded_from_state === "fix_loop"
      && summary?.execution_epoch === currentEpoch
      && summary?.provenance?.kind === "fix-attempt-result"
      && Number.isSafeInteger(summary?.provenance?.fix_attempt)
      && nonEmptyString(summary?.path)
      && nonEmptyString(summary?.sha256))
    .sort((left, right) => (right.provenance.fix_attempt - left.provenance.fix_attempt)
      || nonEmptyString(right.recorded_at).localeCompare(nonEmptyString(left.recorded_at))
      || nonEmptyString(right.path).localeCompare(nonEmptyString(left.path)))[0] || null;
}

function fixAttemptResultArtifactProblem(code, message, artifactRef = null) {
  return buildIssue(`fix_attempt_result_${code}`, message, artifactRef ? { result_artifact_ref: artifactRef } : {});
}

async function readReusableFixAttemptResult(runDir, snapshot) {
  const summary = fixAttemptResultArtifactSummary(snapshot);
  if (!summary) return null;

  const artifactRef = { path: summary.path, sha256: summary.sha256 };
  const attempt = summary.provenance.fix_attempt;
  const fixIntent = buildFixAttemptIntent(snapshot, {
    attempt,
    maxAttempts: MAX_FIX_ATTEMPTS,
  });

  let artifactContent;
  try {
    artifactContent = await fs.readFile(path.join(runDir, summary.path));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        reusable: false,
        artifact_ref: artifactRef,
        problem: fixAttemptResultArtifactProblem(
          "artifact_missing",
          `Recorded fix-attempt result cannot be resumed because artifact ${summary.path} is missing.`,
          artifactRef,
        ),
      };
    }
    throw error;
  }

  if (sha256Hex(artifactContent) !== summary.sha256) {
    return {
      reusable: false,
      artifact_ref: artifactRef,
      problem: fixAttemptResultArtifactProblem(
        "artifact_corrupt",
        `Recorded fix-attempt result cannot be resumed because artifact ${summary.path} no longer matches its recorded hash.`,
        artifactRef,
      ),
    };
  }

  let artifactReport;
  try {
    artifactReport = JSON.parse(artifactContent.toString("utf8"));
  } catch {
    return {
      reusable: false,
      artifact_ref: artifactRef,
      problem: fixAttemptResultArtifactProblem(
        "artifact_invalid",
        `Recorded fix-attempt result cannot be resumed because artifact ${summary.path} is not valid JSON.`,
        artifactRef,
      ),
    };
  }

  const resultProblem = validateImplementationDispatchResultReport(artifactReport, fixIntent.intent, {
    requireCompleteProvenance: false,
    intentArtifactPath: fixIntent.artifactPath,
  });
  const missingIntentArtifact = !isRecord(artifactReport.dispatch_intent_artifact)
    || !nonEmptyString(artifactReport.dispatch_intent_artifact.path)
    || !nonEmptyString(artifactReport.dispatch_intent_artifact.sha256);
  if (resultProblem || missingIntentArtifact) {
    return {
      reusable: false,
      artifact_ref: artifactRef,
      problem: fixAttemptResultArtifactProblem(
        "artifact_invalid",
        `Recorded fix-attempt result cannot be resumed because artifact ${summary.path} does not match the current fix-attempt intent.`,
        artifactRef,
      ),
    };
  }

  const evidence = sanitizeImplementationDispatchEvidence(artifactReport.evidence);
  const intentArtifactRef = isRecord(summary.provenance?.intent_artifact)
    ? summary.provenance.intent_artifact
    : artifactReport.dispatch_intent_artifact;
  return {
    reusable: true,
    artifact_ref: artifactRef,
    intent_artifact_ref: intentArtifactRef,
    fix_attempt: attempt,
    max_fix_attempts: MAX_FIX_ATTEMPTS,
    public_report: {
      status: artifactReport.status,
      summary: implementationDispatchStatusSummary(artifactReport.status),
      implementation_epoch: Number.isSafeInteger(artifactReport.implementation_epoch) ? artifactReport.implementation_epoch : 1,
      dispatch_intent_id: artifactReport.dispatch_intent_id,
      dispatch_intent_artifact: artifactReport.dispatch_intent_artifact,
      packet_artifact: artifactReport.packet_artifact,
      workspace_preparation_artifact: artifactReport.workspace_preparation_artifact,
      evidence,
      problem: sanitizeImplementationDispatchProblem(artifactReport.status, artifactReport.problem),
      adapter: nonEmptyString(artifactReport.adapter) || IMPLEMENTATION_DISPATCH_ADAPTER,
      actor: nonEmptyString(artifactReport.actor) || IMPLEMENTATION_DISPATCH_ADAPTER,
    },
    adapter: nonEmptyString(artifactReport.adapter) || IMPLEMENTATION_DISPATCH_ADAPTER,
    actor: nonEmptyString(artifactReport.actor) || IMPLEMENTATION_DISPATCH_ADAPTER,
    status: artifactReport.status,
  };
}

export async function runFixLoopStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, internalReview, clock, actor, implementationDispatchAdapter, registryRepository } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const paths = registry.getRunPaths(registryRoot, runId);
  const reusableFixAttemptResult = await readReusableFixAttemptResult(paths.runDir, current);
  if (reusableFixAttemptResult?.reusable === false) {
    blockers.push(reusableFixAttemptResult.problem);
    stepsTaken.push(buildStep({
      action: "fix_attempt_resume",
      status: "blocked",
      fromState: "fix_loop",
      toState: "fix_loop",
      detail: reusableFixAttemptResult.problem.message,
      artifactPath: reusableFixAttemptResult.artifact_ref?.path || "",
      artifactSha256: reusableFixAttemptResult.artifact_ref?.sha256 || "",
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

  if (reusableFixAttemptResult?.reusable === true) {
    implementationDispatch = {
      ...reusableFixAttemptResult.public_report,
      fix_attempt: reusableFixAttemptResult.fix_attempt,
      max_fix_attempts: reusableFixAttemptResult.max_fix_attempts,
      intent_artifact_ref: reusableFixAttemptResult.intent_artifact_ref,
      result_artifact_ref: reusableFixAttemptResult.artifact_ref,
      intent_record_status: "noop",
      result_record_status: "noop",
      resumed_recorded_result: true,
    };
    stepsTaken.push(buildStep({
      action: "fix_attempt_resume",
      status: reusableFixAttemptResult.status === "COMPLETED" ? "noop" : "blocked",
      fromState: "fix_loop",
      toState: "fix_loop",
      detail: reusableFixAttemptResult.status === "COMPLETED"
        ? `Existing recorded fix attempt ${reusableFixAttemptResult.fix_attempt}/${MAX_FIX_ATTEMPTS} result was reused.`
        : implementationBoundaryMessage(),
      artifactPath: reusableFixAttemptResult.artifact_ref.path,
      artifactSha256: reusableFixAttemptResult.artifact_ref.sha256,
    }));

    if (reusableFixAttemptResult.status !== "COMPLETED") {
      blockers.push(buildIssue("fix_attempt_blocked", implementationBoundaryMessage(), {
        fix_attempt: reusableFixAttemptResult.fix_attempt,
        max_fix_attempts: MAX_FIX_ATTEMPTS,
        dispatch_status: reusableFixAttemptResult.status,
        problem: implementationDispatch.problem || null,
        intent_artifact_ref: reusableFixAttemptResult.intent_artifact_ref,
        result_artifact_ref: reusableFixAttemptResult.artifact_ref,
        resumed_recorded_result: true,
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

    const transitioned = await registry.transitionRun(registryRoot, runId, {
      toState: "verification",
      actor,
      evidence: {
        reason: "fixes applied",
        fix_loop: {
          fix_attempt: reusableFixAttemptResult.fix_attempt,
          max_fix_attempts: MAX_FIX_ATTEMPTS,
          intent_artifact_ref: reusableFixAttemptResult.intent_artifact_ref,
          result_artifact_ref: reusableFixAttemptResult.artifact_ref,
          resumed_recorded_result: true,
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
      detail: "Resumed fix attempt advanced the run to a fresh verification epoch.",
      sequence: transitioned.event.sequence,
      artifactPath: reusableFixAttemptResult.artifact_ref.path,
      artifactSha256: reusableFixAttemptResult.artifact_ref.sha256,
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

  const completedAttempts = fixAttemptCount(current);
  if (completedAttempts >= MAX_FIX_ATTEMPTS) {
    const problem = buildIssue("fix_attempts_exhausted", `Fix loop stopped after ${completedAttempts} completed attempt${completedAttempts === 1 ? "" : "s"}; maximum is ${MAX_FIX_ATTEMPTS}.`);
    blockers.push(problem);
    const transitioned = await registry.transitionRun(registryRoot, runId, {
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
  const intentRecorded = await registry.recordArtifact(registryRoot, runId, {
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
    intentArtifactPath: fixIntent.artifactPath,
    artifactDirectory: "artifacts/fix-loop",
  });
  const resultRecorded = await registry.recordArtifact(registryRoot, runId, {
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

  const transitioned = await registry.transitionRun(registryRoot, runId, {
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
 * implementation dispatch, verification, internal review, and SCM handoff projection. In
 * `running`, it records workspace-preparation and dispatch-intent artifacts, invokes
 * the configured implementation-dispatch adapter only when no current result artifact
 * is already reusable, records the sanitized result artifact, and advances to
 * verification only after durable completion evidence. BLOCKED results stay in
 * `running`; FAILED results transition to `failed_execution`.
 *
 * @param {object} params
 * @param {string} params.registryRoot Absolute registry root that stores run snapshots.
 * @param {string} params.runId Run identifier to load and advance.
 * @param {string} [params.workspaceId=""] Workspace lease identifier required when the run is waiting for lock acquisition.
 * @param {string} [params.workspacePath=""] Optional leased workspace path recorded with the lock.
 * @param {string|number} [params.ttlMs=""] Optional lease TTL forwarded to lease acquisition.
 * @param {() => Date} [params.clock=() => new Date()] Clock source used for artifact timestamps and transitions.
 * @param {string} [params.actor=RUNNER_ACTOR] Actor name recorded on state transitions and artifacts.
 * @param {{adapter?: string, execute(options: object): Promise<object>}} [params.implementationDispatchAdapter=createUnavailableImplementationDispatchAdapter()]
 * Implementation-dispatch adapter invoked from `running` only when no current result artifact can be safely reused.
 * @param {{plan(snapshot: object, options?: object): object, execute(snapshot: object, plan: object, options?: object): Promise<object>, externalSideEffects?: boolean}} params.scmHandoffAdapter
 * Projection adapter used when the run reaches `handoff_ready`.
 * @returns {Promise<object>} Sanitized public runner report describing completed work, blockers, and current state.
 * @throws {Error} When required identifiers are missing or an unexpected storage/adapter error occurs.
 */
