/** Provider-neutral PR/SCM handoff coordination for local mission orchestration. */
import { promises as fs } from "node:fs";
import path from "node:path";

import { TERMINAL_STATES } from "../execution-runs/constants.js";
import { IMPLEMENTATION_DISPATCH_ADAPTER, buildImplementationDispatchIntent, executeImplementationDispatch, implementationDispatchStatusSummary, isUnavailableImplementationDispatchResult, sanitizeImplementationDispatchEvidence, validateImplementationDispatchResultReport } from "../gates/implementation-contract.js";
import { executeInternalReviewGate, sanitizeRecordedInternalReviewReport } from "../gates/internal-review-adapter.js";
import { sanitizePublicReportForOutput } from "../observability/index.js";
import { buildRecordedPrProjection, createLocalPrProjectionAdapter } from "../workflow-boundary/pr-scm-projection/local-journal-adapter.js";
import { executeVerificationGate } from "../gates/verification-adapter.js";
import { evaluateReviewReadyPolicy } from "../stack-workflow/review-ready-policy.js";
import { assertRegistryRepository } from "../execution-runs/registry/index.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";
import { hasActiveLease } from "./mission-context.js";
import { buildIssue, buildRunnerReport, buildStep, implementationBoundaryMessage, internalReviewTransition, internalReviewTransitionReason, leaseRequiredMessage, projectionProblemCode, projectionTransitionReason, unsupportedStageMessage, verificationTransition, verificationTransitionReason } from "./final-report.js";


function toHandoffTarget(githubPr) {
  if (!isRecord(githubPr)) return null;
  return {
    provider: "github",
    kind: "pull_request",
    number: githubPr.number,
    url: githubPr.url,
    repo: githubPr.repo,
    issue_number: githubPr.issue_number ?? null,
    head_branch: githubPr.head_branch,
    base_branch: githubPr.base_branch,
    state: githubPr.state,
    draft: githubPr.draft,
    title: githubPr.title,
    projection_mode: githubPr.projection_mode || "",
    projected_at: githubPr.projected_at || null,
    actor: githubPr.actor || "",
  };
}
function sanitizeRunnerReportMessage(message) {
  const sanitized = sanitizePublicReportForOutput(nonEmptyString(message), []);
  return nonEmptyString(sanitized) || "Sensitive error details were redacted from the local runner report.";
}

function buildProjectionProblem(code, message, extra = {}) {
  return buildIssue(projectionProblemCode(code), sanitizeRunnerReportMessage(message), extra);
}

function projectionProblemFromError(error) {
  const message = sanitizeRunnerReportMessage(error?.message || String(error));
  const code = nonEmptyString(error?.code);
  if (code === "projection_missing_base_branch") return buildProjectionProblem("missing_base_branch", message);
  if (code === "projection_invalid_transport_status" || code === "projection_invalid_transport_result" || code === "projection_invalid_github_pr") {
    return buildProjectionProblem("invalid_transport_result", message);
  }
  if (code.startsWith("projection_github_")) return buildProjectionProblem(code.slice("projection_".length), message);
  if (/different hash/i.test(message)) {
    return buildProjectionProblem("artifact_corrupt", `Recorded SCM handoff projection cannot be resumed because its local artifact is corrupt: ${message}`);
  }
  return buildProjectionProblem("record_failed", `SCM handoff projection handoff could not be recorded locally: ${message}`);
}

export async function runPrReadyStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, internalReview, clock, actor, prProjectionAdapter = createLocalPrProjectionAdapter(), registryRepository } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  let projection = null;
  let plannedProjection;
  let intentArtifactRef = null;
  let intentRecordStatus = "not_recorded";
  let projectionExternalSideEffects = Boolean(prProjectionAdapter?.externalSideEffects);

  try {
    plannedProjection = prProjectionAdapter.plan(current, { clock, actor });
    projectionExternalSideEffects = Boolean(plannedProjection.externalSideEffects);
    const intentRecorded = await registry.recordProjectionIntent(registryRoot, runId, {
      projection_name: plannedProjection.projectionName,
      projection_target: plannedProjection.projectionTarget,
      adapter: plannedProjection.adapter,
      mode: plannedProjection.mode,
      execution_epoch: plannedProjection.executionEpoch,
      recorded_from_state: "handoff_ready",
      idempotency_key: plannedProjection.intentIdempotencyKey,
      artifactPath: plannedProjection.intentArtifactPath,
      content: plannedProjection.intentArtifactContent,
      actor: plannedProjection.actor,
      recorded_at: plannedProjection.recordedAt,
    });
    current = intentRecorded.run;
    intentArtifactRef = intentRecorded.artifact_ref;
    intentRecordStatus = intentRecorded.status;
    stepsTaken.push(buildStep({
      action: "projection_intent_recorded",
      status: intentRecorded.status === "noop" ? "noop" : "completed",
      fromState: "handoff_ready",
      toState: "handoff_ready",
      detail: projectionExternalSideEffects
        ? "SCM handoff projection intent was recorded locally before the transport-backed handoff."
        : "SCM handoff projection intent was recorded locally without a remote GitHub write.",
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

    const resultRecorded = await registry.recordProjectionResult(registryRoot, runId, {
      projection_name: plannedProjection.projectionName,
      projection_target: plannedProjection.projectionTarget,
      adapter: plannedProjection.adapter,
      mode: plannedProjection.mode,
      execution_epoch: plannedProjection.executionEpoch,
      recorded_from_state: "handoff_ready",
      idempotency_key: plannedProjection.resultIdempotencyKey,
      intent_idempotency_key: plannedProjection.intentIdempotencyKey,
      status: plannedProjection.result.status,
      handoff_target: toHandoffTarget(plannedProjection.githubPr),
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
      fromState: "handoff_ready",
      toState: "handoff_ready",
      detail: projectionExternalSideEffects
        ? "SCM handoff projection result was recorded locally after the transport-backed PR handoff."
        : "SCM projection result was recorded locally and mirrored into handoff_target without a remote write.",
      sequence: resultRecorded.event?.sequence ?? null,
      artifactPath: resultRecorded.artifact_ref.path,
      artifactSha256: resultRecorded.artifact_ref.sha256,
    }));
  } catch (error) {
    const problem = projectionProblemFromError(error);
    projection = {
      ...(plannedProjection?.publicReport || {
        status: "blocked",
        adapter: prProjectionAdapter?.adapter || "local-github-pr-projection",
        mode: prProjectionAdapter?.mode || "local_fake",
      }),
      intent_artifact_ref: intentArtifactRef,
      intent_record_status: intentRecordStatus,
      result_record_status: "blocked",
      problem,
    };
    blockers.push(problem);
    stepsTaken.push(buildStep({
      action: "projection_result_recorded",
      status: "blocked",
      fromState: "handoff_ready",
      toState: "handoff_ready",
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

  const transitioned = await registry.transitionRun(registryRoot, runId, {
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
        handoff_target: toHandoffTarget(plannedProjection.githubPr),
        result_artifact_ref: projection.result_artifact_ref,
      },
    },
    clock,
  });
  current = transitioned.run;
  stepsTaken.push(buildStep({
    action: "transition",
    status: "completed",
    fromState: "handoff_ready",
    toState: current.state,
    detail: "Recorded SCM handoff projection handoff advanced the run to ready_for_manual_review.",
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
