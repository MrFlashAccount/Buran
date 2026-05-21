/** Implementation dispatch phase runner for local mission orchestration. */
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
import { inspectWorkspacePreparation } from "../integrations/worktree/filesystem/workspace-preparation.js";
import { hasActiveLease } from "./mission-context.js";
import { buildIssue, buildRunnerReport, buildStep, implementationBoundaryMessage, internalReviewTransition, internalReviewTransitionReason, leaseRequiredMessage, projectionProblemCode, projectionTransitionReason, sanitizeImplementationDispatchProblem, unsupportedStageMessage, verificationTransition, verificationTransitionReason } from "./final-report.js";

function dispatchResultArtifactSummary(snapshot, dispatchIntentId) {
  const currentEpoch = snapshot?.execution?.current_epoch;
  if (!Number.isSafeInteger(currentEpoch)) return null;
  const artifacts = Object.values(snapshot?.artifacts?.recorded?.by_path || {});
  return artifacts
    .filter((summary) => summary?.gate_name === "implementation_dispatch"
      && summary?.recorded_from_state === "running"
      && summary?.execution_epoch === currentEpoch
      && summary?.provenance?.kind === "implementation-dispatch-result"
      && summary?.provenance?.dispatch_intent_id === dispatchIntentId
      && nonEmptyString(summary?.path)
      && nonEmptyString(summary?.sha256))
    .sort((left, right) => nonEmptyString(right.recorded_at).localeCompare(nonEmptyString(left.recorded_at)) || nonEmptyString(right.path).localeCompare(nonEmptyString(left.path)))[0] || null;
}

function dispatchResultArtifactProblem(code, message, artifactRef = null) {
  return buildIssue(`implementation_dispatch_result_${code}`, message, artifactRef ? { result_artifact_ref: artifactRef } : {});
}

async function readReusableImplementationDispatchResult(runDir, snapshot, intent) {
  const summary = dispatchResultArtifactSummary(snapshot, intent?.dispatch_intent_id);
  if (!summary) return null;

  const artifactRef = { path: summary.path, sha256: summary.sha256 };
  const absoluteArtifactPath = path.join(runDir, summary.path);
  let artifactContent;
  try {
    artifactContent = await fs.readFile(absoluteArtifactPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        reusable: false,
        artifact_ref: artifactRef,
        problem: dispatchResultArtifactProblem(
          "artifact_missing",
          `Recorded implementation dispatch result cannot be resumed because artifact ${summary.path} is missing.`,
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
      problem: dispatchResultArtifactProblem(
        "artifact_corrupt",
        `Recorded implementation dispatch result cannot be resumed because artifact ${summary.path} no longer matches its recorded hash.`,
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
      problem: dispatchResultArtifactProblem(
        "artifact_invalid",
        `Recorded implementation dispatch result cannot be resumed because artifact ${summary.path} is not valid JSON.`,
        artifactRef,
      ),
    };
  }

  const resultProblem = validateImplementationDispatchResultReport(artifactReport, intent);
  if (resultProblem) {
    return {
      reusable: false,
      artifact_ref: artifactRef,
      problem: dispatchResultArtifactProblem(
        "artifact_invalid",
        `Recorded implementation dispatch result cannot be resumed because artifact ${summary.path} does not match the current dispatch intent.`,
        artifactRef,
      ),
    };
  }

  if (artifactReport.status === "BLOCKED" && isUnavailableImplementationDispatchResult(artifactReport)) {
    return null;
  }

  const evidence = sanitizeImplementationDispatchEvidence(artifactReport.evidence);
  return {
    reusable: true,
    artifact_ref: artifactRef,
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

export function buildImplementationDispatchStageResult({
  current,
  stepsTaken,
  blockers,
  warnings,
  workspacePreparation,
  implementationDispatch,
}) {
  return {
    current,
    reportInput: {
      currentState: current?.state || "",
      outcome: current?.state === "failed_execution" ? "failed" : blockers.length > 0 ? "blocked" : "completed",
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
    },
  };
}

export async function runImplementationDispatchStage({ runContext = {}, reportState = {}, services = {} } = {}) {
  const { registryRoot, runId, paths } = runContext;
  let { current } = runContext;
  const stepsTaken = [...(reportState.stepsTaken || [])];
  const blockers = [...(reportState.blockers || [])];
  const warnings = [...(reportState.warnings || [])];
  let workspacePreparation = reportState.workspacePreparation ?? null;
  let implementationDispatch = reportState.implementationDispatch ?? null;
  const {
    clock = () => new Date(),
    actor = RUNNER_ACTOR,
    implementationDispatchAdapter = createUnavailableImplementationDispatchAdapter(),
  } = services;
  const registry = assertRegistryRepository(services.registryRepository);
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
      const recorded = await registry.recordArtifact(registryRoot, runId, {
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
      const dispatchRecorded = await registry.recordArtifact(registryRoot, runId, {
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

      let dispatchResult = null;
      let dispatchResultRecorded = null;
      const reusableDispatchResult = await readReusableImplementationDispatchResult(paths.runDir, current, dispatchIntent.intent);

      if (reusableDispatchResult?.reusable === true) {
        dispatchResult = reusableDispatchResult;
        implementationDispatch = {
          ...reusableDispatchResult.public_report,
          intent_artifact_ref: dispatchRecorded.artifact_ref,
          result_artifact_ref: reusableDispatchResult.artifact_ref,
          intent_record_status: dispatchRecorded.status,
          result_record_status: "noop",
          resumed_recorded_result: true,
          workspace_preparation_artifact_ref: recorded.artifact_ref,
        };
        stepsTaken.push(buildStep({
          action: "implementation_dispatch_result",
          status: "noop",
          fromState: "running",
          toState: "running",
          detail: "Existing current-epoch implementation dispatch result was reused without invoking the adapter.",
          workspaceId: current.workspace?.id || "",
          artifactPath: reusableDispatchResult.artifact_ref.path,
          artifactSha256: reusableDispatchResult.artifact_ref.sha256,
        }));
      } else if (reusableDispatchResult?.reusable === false) {
        implementationDispatch = {
          status: "BLOCKED",
          summary: implementationBoundaryMessage(),
          problem: reusableDispatchResult.problem,
          intent_artifact_ref: dispatchRecorded.artifact_ref,
          result_artifact_ref: reusableDispatchResult.artifact_ref,
          intent_record_status: dispatchRecorded.status,
          result_record_status: "stale_recorded_result",
          resumed_recorded_result: false,
          workspace_preparation_artifact_ref: recorded.artifact_ref,
        };
        stepsTaken.push(buildStep({
          action: "implementation_dispatch_result",
          status: "blocked",
          fromState: "running",
          toState: "running",
          detail: reusableDispatchResult.problem.message,
          workspaceId: current.workspace?.id || "",
          artifactPath: reusableDispatchResult.artifact_ref.path,
          artifactSha256: reusableDispatchResult.artifact_ref.sha256,
        }));
        blockers.push(buildIssue("implementation_dispatch_blocked", implementationBoundaryMessage(), {
          dispatch_status: implementationDispatch.status,
          problem: implementationDispatch.problem,
          intent_artifact_ref: implementationDispatch.intent_artifact_ref,
          result_artifact_ref: implementationDispatch.result_artifact_ref,
        }));
      } else {
        dispatchResult = await executeImplementationDispatch({
          snapshot: current,
          intent: dispatchIntent.intent,
          adapter: implementationDispatchAdapter,
          clock,
        });
        dispatchResultRecorded = await registry.recordArtifact(registryRoot, runId, {
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
          resumed_recorded_result: false,
          workspace_preparation_artifact_ref: recorded.artifact_ref,
        };
        stepsTaken.push(buildStep({
          action: "implementation_dispatch_result",
          status: dispatchResultRecorded.status === "noop" ? "noop" : dispatchResult.status === "COMPLETED" ? "completed" : dispatchResult.status === "FAILED" ? "failed" : "blocked",
          fromState: "running",
          toState: "running",
          detail: dispatchResult.public_report.summary || implementationBoundaryMessage(),
          sequence: dispatchResultRecorded.event?.sequence ?? null,
          workspaceId: current.workspace?.id || "",
          artifactPath: dispatchResultRecorded.artifact_ref.path,
          artifactSha256: dispatchResultRecorded.artifact_ref.sha256,
        }));
      }

      warnings.push(...inspected.warnings);
      const dispatchStatus = implementationDispatch?.status;
      const dispatchAdapter = dispatchResult?.adapter || implementationDispatch?.adapter || IMPLEMENTATION_DISPATCH_ADAPTER;
      if (dispatchStatus === "COMPLETED") {
        const transitioned = await registry.transitionRun(registryRoot, runId, {
          toState: "verification",
          actor,
          evidence: {
            reason: "implementation completed",
            implementation_dispatch: {
              adapter: dispatchAdapter,
              status: dispatchStatus,
              intent_artifact_ref: dispatchRecorded.artifact_ref,
              result_artifact_ref: implementationDispatch.result_artifact_ref,
              resumed_recorded_result: Boolean(implementationDispatch.resumed_recorded_result),
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
          artifactPath: implementationDispatch.result_artifact_ref.path,
          artifactSha256: implementationDispatch.result_artifact_ref.sha256,
        }));
      } else if (dispatchStatus === "FAILED") {
        const transitioned = await registry.transitionRun(registryRoot, runId, {
          toState: "failed_execution",
          actor,
          evidence: {
            reason: "unrecoverable implementation failure",
            implementation_dispatch: {
              adapter: dispatchAdapter,
              status: dispatchStatus,
              problem: implementationDispatch.problem || null,
              intent_artifact_ref: dispatchRecorded.artifact_ref,
              result_artifact_ref: implementationDispatch.result_artifact_ref,
              resumed_recorded_result: Boolean(implementationDispatch.resumed_recorded_result),
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
          detail: "Failed implementation-harness dispatch advanced the run to failed_execution.",
          sequence: transitioned.event.sequence,
          artifactPath: implementationDispatch.result_artifact_ref.path,
          artifactSha256: implementationDispatch.result_artifact_ref.sha256,
        }));
        blockers.push(buildIssue("implementation_dispatch_failed", "Implementation harness dispatch failed inside the approved envelope.", {
          dispatch_status: implementationDispatch.status,
          problem: implementationDispatch.problem || null,
          intent_artifact_ref: implementationDispatch.intent_artifact_ref,
          result_artifact_ref: implementationDispatch.result_artifact_ref,
        }));
      } else if (reusableDispatchResult?.reusable !== false) {
        blockers.push(buildIssue("implementation_dispatch_blocked", implementationBoundaryMessage(), {
          dispatch_status: implementationDispatch.status,
          problem: implementationDispatch.problem || null,
          intent_artifact_ref: implementationDispatch.intent_artifact_ref,
          result_artifact_ref: implementationDispatch.result_artifact_ref,
        }));
      }
    }
  }

  return buildImplementationDispatchStageResult({
    current,
    stepsTaken,
    blockers,
    warnings,
    workspacePreparation,
    implementationDispatch,
  });
}

/**
 * Executes one bounded implementation-harness fix attempt, then returns the run to verification.
 */
