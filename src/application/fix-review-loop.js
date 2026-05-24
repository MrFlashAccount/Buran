/** Fix/review retry-loop coordination for local mission orchestration. */
import { promises as fs } from "node:fs";
import { IMPLEMENTATION_DISPATCH_ADAPTER, executeImplementationDispatch, implementationDispatchStatusSummary, sanitizeImplementationDispatchEvidence, validateImplementationDispatchResultReport } from "../gates/implementation-contract.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";
import { hasActiveLease } from "./mission-context.js";
import { resolveRecordedArtifactPath } from "./recorded-artifacts.js";
import { buildIssue, buildRunnerReport, buildStep, implementationBoundaryMessage, sanitizeImplementationDispatchProblem } from "./final-report.js";

const MAX_FIX_ATTEMPTS = 2;
const WAITING_FIX_ATTEMPT_STATUSES = new Set(["PENDING", "UNKNOWN", "STALE"]);

function recordedFixAttemptArtifacts(snapshot) {
  const byPath = snapshot?.artifacts?.recorded?.by_path || {};
  return Object.values(byPath).filter((summary) => summary?.gate_name === "fix_attempt");
}

function fixAttemptCount(snapshot) {
  return recordedFixAttemptArtifacts(snapshot)
    .filter((summary) => summary?.provenance?.kind === "fix-attempt-result")
    .filter((summary) => !WAITING_FIX_ATTEMPT_STATUSES.has(nonEmptyString(summary?.provenance?.status).toUpperCase()))
    .length;
}

function buildFixAttemptIntent(snapshot, { attempt, maxAttempts, includeWorkerTask = true } = {}) {
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
    ...(includeWorkerTask ? {
      worker_task_id: nonEmptyString(snapshot?.worker_tasks?.head?.worker_task_id),
      worker_task_role: nonEmptyString(snapshot?.worker_tasks?.head?.role),
      worker_task_epoch: snapshot?.worker_tasks?.head?.epoch ?? snapshot?.execution?.current_epoch ?? 0,
      worker_task_attempt: snapshot?.worker_tasks?.head?.attempt ?? attempt,
      completion_authority: nonEmptyString(snapshot?.worker_tasks?.head?.authority) || IMPLEMENTATION_DISPATCH_ADAPTER,
      completion_idempotency_key: `${snapshot?.run_id || "run"}:worker_completion:fix_attempt:${attempt}:${nonEmptyString(snapshot?.worker_tasks?.head?.worker_task_id) || "legacy"}`,
    } : {}),
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

  const resolvedArtifact = resolveRecordedArtifactPath(runDir, summary.path);
  if (!resolvedArtifact) {
    return {
      reusable: false,
      artifact_ref: artifactRef,
      problem: fixAttemptResultArtifactProblem(
        "artifact_unsafe_path",
        `Recorded fix-attempt result cannot be resumed because artifact ${summary.path} is not a safe recorded artifact path.`,
        artifactRef,
      ),
    };
  }

  let artifactContent;
  try {
    artifactContent = await fs.readFile(resolvedArtifact.absolutePath);
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

  let resultProblem = validateImplementationDispatchResultReport(artifactReport, fixIntent.intent, {
    requireCompleteProvenance: false,
    intentArtifactPath: fixIntent.artifactPath,
  });
  if (resultProblem) {
    const legacyFixIntent = buildFixAttemptIntent(snapshot, {
      attempt,
      maxAttempts: MAX_FIX_ATTEMPTS,
      includeWorkerTask: false,
    });
    const legacyResultProblem = validateImplementationDispatchResultReport(artifactReport, legacyFixIntent.intent, {
      requireCompleteProvenance: false,
      intentArtifactPath: legacyFixIntent.artifactPath,
    });
    if (!legacyResultProblem) {
      resultProblem = null;
      fixIntent.intent = {
        ...legacyFixIntent.intent,
        worker_task_id: nonEmptyString(snapshot?.worker_tasks?.head?.worker_task_id),
        worker_task_role: nonEmptyString(snapshot?.worker_tasks?.head?.role),
        worker_task_epoch: snapshot?.worker_tasks?.head?.epoch ?? snapshot?.execution?.current_epoch ?? 0,
        worker_task_attempt: snapshot?.worker_tasks?.head?.attempt ?? attempt,
        completion_authority: nonEmptyString(snapshot?.worker_tasks?.head?.authority) || IMPLEMENTATION_DISPATCH_ADAPTER,
        completion_idempotency_key: `${snapshot?.run_id || "run"}:worker_completion:fix_attempt:${attempt}:${nonEmptyString(snapshot?.worker_tasks?.head?.worker_task_id) || "legacy"}`,
      };
      fixIntent.artifactPath = legacyFixIntent.artifactPath;
    }
  }
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

  if (WAITING_FIX_ATTEMPT_STATUSES.has(artifactReport.status)
    && nonEmptyString(artifactReport.adapter_task_id)
    && nonEmptyString(snapshot?.worker_tasks?.head?.dispatch?.adapter_task_id) === nonEmptyString(artifactReport.adapter_task_id)) {
    return null;
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
      adapter_task_id: nonEmptyString(artifactReport.adapter_task_id),
      adapter_status: nonEmptyString(artifactReport.adapter_status) || artifactReport.status,
      heartbeat_at: nonEmptyString(artifactReport.heartbeat_at),
      status_summary_ref: artifactReport.status_summary_ref || null,
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
      status: reusableFixAttemptResult.status === "COMPLETED" ? "noop" : WAITING_FIX_ATTEMPT_STATUSES.has(reusableFixAttemptResult.status) ? "waiting" : "blocked",
      fromState: "fix_loop",
      toState: "fix_loop",
      detail: reusableFixAttemptResult.status === "COMPLETED"
        ? `Existing recorded fix attempt ${reusableFixAttemptResult.fix_attempt}/${MAX_FIX_ATTEMPTS} result was reused.`
        : WAITING_FIX_ATTEMPT_STATUSES.has(reusableFixAttemptResult.status)
          ? `Existing recorded fix attempt ${reusableFixAttemptResult.fix_attempt}/${MAX_FIX_ATTEMPTS} is ${reusableFixAttemptResult.status}; waiting for worker completion evidence.`
          : implementationBoundaryMessage(),
      artifactPath: reusableFixAttemptResult.artifact_ref.path,
      artifactSha256: reusableFixAttemptResult.artifact_ref.sha256,
    }));

    if (WAITING_FIX_ATTEMPT_STATUSES.has(reusableFixAttemptResult.status)) {
      warnings.push(buildIssue("fix_attempt_waiting", `${implementationDispatch.summary || implementationDispatchStatusSummary(reusableFixAttemptResult.status)} Reinvoke /buran run after worker heartbeat or completion evidence is available.`, {
        fix_attempt: reusableFixAttemptResult.fix_attempt,
        max_fix_attempts: MAX_FIX_ATTEMPTS,
        dispatch_status: reusableFixAttemptResult.status,
        intent_artifact_ref: reusableFixAttemptResult.intent_artifact_ref,
        result_artifact_ref: reusableFixAttemptResult.artifact_ref,
        adapter_task_id: implementationDispatch.adapter_task_id || "",
        resumed_recorded_result: true,
      }));
      return buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "waiting",
        stepsTaken,
        blockers,
        warnings,
        workspacePreparation,
        implementationDispatch,
        verification,
        internalReview,
      });
    }

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

    const recordedAt = clock().toISOString();
    const workerTaskCreated = await registry.recordWorkerTaskCreated(registryRoot, runId, {
      purpose: "fix_attempt",
      role: "fixer",
      epoch: current.execution?.current_epoch || 0,
      attempt: reusableFixAttemptResult.fix_attempt,
      authority: IMPLEMENTATION_DISPATCH_ADAPTER,
      recorded_at: recordedAt,
      actor,
      idempotency_key: `${runId}:worker_task:fix_attempt:${current.execution?.current_epoch || 0}:${reusableFixAttemptResult.fix_attempt}`,
    });
    current = workerTaskCreated.run;
    const reusableFixIntent = buildFixAttemptIntent(current, { attempt: reusableFixAttemptResult.fix_attempt, maxAttempts: MAX_FIX_ATTEMPTS });
    await registry.recordWorkerTaskDispatch(registryRoot, runId, {
      intent_ref: reusableFixAttemptResult.intent_artifact_ref,
      dispatch_ref: reusableFixAttemptResult.intent_artifact_ref,
      recorded_at: recordedAt,
      actor,
      idempotency_key: `${reusableFixIntent.intent.completion_idempotency_key.replace(":worker_completion:", ":worker_dispatch:")}:${reusableFixAttemptResult.intent_artifact_ref.sha256}`,
    });
    const reusableCompletionIdempotencyKey = `${reusableFixIntent.intent.completion_idempotency_key}:${reusableFixAttemptResult.artifact_ref.sha256}`;
    const completionRecorded = await registry.recordWorkerCompletion(registryRoot, runId, {
      worker_task_id: reusableFixIntent.intent.worker_task_id,
      purpose: "fix_attempt",
      role: reusableFixIntent.intent.worker_task_role,
      epoch: reusableFixIntent.intent.worker_task_epoch,
      attempt: reusableFixIntent.intent.worker_task_attempt,
      authority: reusableFixIntent.intent.completion_authority,
      status: reusableFixAttemptResult.status,
      completion_ref: reusableFixAttemptResult.artifact_ref,
      evidence: reusableFixAttemptResult.public_report?.evidence || {},
      received_at: clock().toISOString(),
      actor: reusableFixAttemptResult.adapter || IMPLEMENTATION_DISPATCH_ADAPTER,
      idempotency_key: reusableCompletionIdempotencyKey,
    });
    current = completionRecorded.run;
    const decisionRecorded = await registry.recordWorkerCompletionDecision(registryRoot, runId, {
      completion: current.worker_tasks?.head?.completion,
      decided_at: clock().toISOString(),
      actor,
      idempotency_key: `${reusableCompletionIdempotencyKey}:decision`,
    });
    current = decisionRecorded.run;
    if (current.worker_tasks?.head?.decision?.decision !== "accepted") {
      blockers.push(buildIssue("worker_completion_not_accepted", "Reusable fix completion did not receive an accepted durable CompletionDecision.", {
        worker_decision: current.worker_tasks?.head?.decision?.decision || "",
        worker_task_id: current.worker_tasks?.head?.worker_task_id || "",
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
  const recordedAt = clock().toISOString();
  const workerTaskCreated = await registry.recordWorkerTaskCreated(registryRoot, runId, {
    purpose: "fix_attempt",
    role: "fixer",
    epoch: current.execution?.current_epoch || 0,
    attempt,
    authority: IMPLEMENTATION_DISPATCH_ADAPTER,
    recorded_at: recordedAt,
    actor,
    idempotency_key: `${runId}:worker_task:fix_attempt:${current.execution?.current_epoch || 0}:${attempt}`,
  });
  current = workerTaskCreated.run;
  stepsTaken.push(buildStep({
    action: "worker_task_created",
    status: workerTaskCreated.status === "noop" ? "noop" : "completed",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: `Durable fix-attempt WorkerTask ${attempt}/${MAX_FIX_ATTEMPTS} was created before adapter execution.`,
    sequence: workerTaskCreated.event?.sequence ?? null,
  }));
  const fixIntent = buildFixAttemptIntent(current, {
    attempt,
    maxAttempts: MAX_FIX_ATTEMPTS,
  });
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
  const activeDispatch = current.worker_tasks?.head?.dispatch || {};
  const workerTaskDispatched = activeDispatch.adapter_task_id || (workerTaskCreated.status === "noop" && intentRecorded.status === "noop")
    ? { status: "noop", run: current, event: null }
    : await registry.recordWorkerTaskDispatch(registryRoot, runId, {
      intent_ref: intentRecorded.artifact_ref,
      dispatch_ref: intentRecorded.artifact_ref,
      recorded_at: recordedAt,
      actor,
      idempotency_key: `${fixIntent.intent.completion_idempotency_key.replace(":worker_completion:", ":worker_dispatch:")}:${intentRecorded.artifact_ref.sha256}`,
    });
  current = workerTaskDispatched.run;
  stepsTaken.push(buildStep({
    action: "worker_task_dispatch_recorded",
    status: workerTaskDispatched.status === "noop" ? "noop" : "completed",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: "Fix-attempt WorkerTask dispatch intent was recorded as durable task evidence.",
    sequence: workerTaskDispatched.event?.sequence ?? null,
    artifactPath: intentRecorded.artifact_ref.path,
    artifactSha256: intentRecorded.artifact_ref.sha256,
  }));
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
    status: resultRecorded.status === "noop" ? "noop" : dispatchResult.status === "COMPLETED" ? "completed" : WAITING_FIX_ATTEMPT_STATUSES.has(dispatchResult.status) ? "waiting" : "blocked",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: dispatchResult.public_report.summary || implementationBoundaryMessage(),
    sequence: resultRecorded.event?.sequence ?? null,
    artifactPath: resultRecorded.artifact_ref.path,
    artifactSha256: resultRecorded.artifact_ref.sha256,
  }));

  if (implementationDispatch?.adapter_task_id || implementationDispatch?.heartbeat_at || implementationDispatch?.status_summary_ref) {
    const adapterDispatchRecorded = await registry.recordWorkerTaskDispatch(registryRoot, runId, {
      intent_ref: intentRecorded.artifact_ref,
      dispatch_ref: intentRecorded.artifact_ref,
      adapter_id: implementationDispatch.adapter || dispatchResult.adapter || IMPLEMENTATION_DISPATCH_ADAPTER,
      adapter_task_id: implementationDispatch.adapter_task_id || "",
      adapter_status: implementationDispatch.adapter_status || implementationDispatch.status || "",
      heartbeat_at: implementationDispatch.heartbeat_at || "",
      status_summary_ref: implementationDispatch.status_summary_ref || null,
      recorded_at: clock().toISOString(),
      actor: implementationDispatch.adapter || dispatchResult.adapter || IMPLEMENTATION_DISPATCH_ADAPTER,
      idempotency_key: `${fixIntent.intent.completion_idempotency_key.replace(":worker_completion:", ":worker_dispatch_adapter_status:")}:${implementationDispatch.adapter_task_id || implementationDispatch.adapter_status || implementationDispatch.status || "unknown"}:${implementationDispatch.result_artifact_ref?.sha256 || "no-result"}`,
    });
    current = adapterDispatchRecorded.run;
    implementationDispatch = {
      ...implementationDispatch,
      worker_task: current.worker_tasks?.head || null,
    };
    stepsTaken.push(buildStep({
      action: "worker_task_adapter_status_recorded",
      status: adapterDispatchRecorded.status === "noop" ? "noop" : "completed",
      fromState: "fix_loop",
      toState: "fix_loop",
      detail: "Fix-attempt WorkerTask adapter task identity/status was recorded for bounded reattach/poll resume.",
      sequence: adapterDispatchRecorded.event?.sequence ?? null,
      artifactPath: implementationDispatch.result_artifact_ref?.path || "",
      artifactSha256: implementationDispatch.result_artifact_ref?.sha256 || "",
    }));
  }

  if (WAITING_FIX_ATTEMPT_STATUSES.has(dispatchResult.status)) {
    warnings.push(buildIssue("fix_attempt_waiting", `${implementationDispatch.summary || implementationDispatchStatusSummary(dispatchResult.status)} Reinvoke /buran run after worker heartbeat or completion evidence is available.`, {
      fix_attempt: attempt,
      max_fix_attempts: MAX_FIX_ATTEMPTS,
      dispatch_status: dispatchResult.status,
      intent_artifact_ref: intentRecorded.artifact_ref,
      result_artifact_ref: resultRecorded.artifact_ref,
      adapter_task_id: implementationDispatch.adapter_task_id || "",
    }));
    return buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "waiting",
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
    });
  }

  const completionIdempotencyKey = `${fixIntent.intent.completion_idempotency_key}:${resultRecorded.artifact_ref.sha256}`;
  const completionRecorded = await registry.recordWorkerCompletion(registryRoot, runId, {
    worker_task_id: fixIntent.intent.worker_task_id,
    purpose: "fix_attempt",
    role: "fixer",
    epoch: fixIntent.intent.worker_task_epoch,
    attempt: fixIntent.intent.worker_task_attempt,
    authority: fixIntent.intent.completion_authority,
    status: dispatchResult.status,
    completion_ref: resultRecorded.artifact_ref,
    evidence: dispatchResult.public_report?.evidence || {},
    received_at: clock().toISOString(),
    actor: dispatchResult.adapter || IMPLEMENTATION_DISPATCH_ADAPTER,
    idempotency_key: completionIdempotencyKey,
  });
  current = completionRecorded.run;
  const decisionRecorded = await registry.recordWorkerCompletionDecision(registryRoot, runId, {
    completion: current.worker_tasks?.head?.completion,
    decided_at: clock().toISOString(),
    actor,
    idempotency_key: `${completionIdempotencyKey}:decision`,
  });
  current = decisionRecorded.run;
  implementationDispatch = {
    ...implementationDispatch,
    worker_task: current.worker_tasks?.head || null,
  };
  stepsTaken.push(buildStep({
    action: "worker_completion_decided",
    status: decisionRecorded.status === "noop" ? "noop" : "completed",
    fromState: "fix_loop",
    toState: "fix_loop",
    detail: `Fix-attempt worker completion decision recorded as ${current.worker_tasks?.head?.decision?.decision || "unknown"} before outer transition.`,
    sequence: decisionRecorded.event?.sequence ?? null,
    artifactPath: resultRecorded.artifact_ref.path,
    artifactSha256: resultRecorded.artifact_ref.sha256,
  }));

  const acceptedWorkerCompletion = current.worker_tasks?.head?.decision?.decision === "accepted";
  if (dispatchResult.status !== "COMPLETED" || !acceptedWorkerCompletion) {
    blockers.push(buildIssue("fix_attempt_blocked", implementationBoundaryMessage(), {
      fix_attempt: attempt,
      max_fix_attempts: MAX_FIX_ATTEMPTS,
      dispatch_status: dispatchResult.status,
      problem: dispatchResult.public_report?.problem || null,
      intent_artifact_ref: intentRecorded.artifact_ref,
      result_artifact_ref: resultRecorded.artifact_ref,
      worker_decision: current.worker_tasks?.head?.decision?.decision || "",
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
