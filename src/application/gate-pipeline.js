/** Verification and internal-review gate pipeline for local mission orchestration. */
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


function internalReviewResumeProblem(code, message, artifactRef = null) {
  return buildIssue(`internal_review_${code}`, message, artifactRef ? { artifact_ref: artifactRef } : {});
}

function resolveRecordedArtifactPath(runDir, artifactPath) {
  const input = nonEmptyString(artifactPath);
  if (!input || path.isAbsolute(input)) return null;
  const absolutePath = path.resolve(runDir, path.normalize(input));
  const relativePath = path.relative(runDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath };
}

async function readRecordedArtifactJson(runDir, artifactRef) {
  const resolved = resolveRecordedArtifactPath(runDir, artifactRef?.path);
  if (!resolved) return null;
  try {
    const artifactText = await fs.readFile(resolved.absolutePath, "utf8");
    return JSON.parse(artifactText);
  } catch {
    return null;
  }
}

async function inspectRecordedInternalReviewEvidence(runDir, gateStatus, reportArtifactRef, { workspacePath = "" } = {}) {
  const reportArtifactPath = nonEmptyString(reportArtifactRef?.path);
  const rawReport = await readRecordedArtifactJson(runDir, reportArtifactRef);
  const report = sanitizeRecordedInternalReviewReport(rawReport, { workspacePath });
  if (!isRecord(rawReport)) {
    return {
      ok: false,
      problem: internalReviewResumeProblem(
        "artifact_invalid",
        `Recorded internal review result cannot be resumed because artifact ${reportArtifactPath || "<unknown>"} is not a valid internal review report.`,
        reportArtifactRef,
      ),
    };
  }

  const reportStatus = nonEmptyString(rawReport.status).toUpperCase();
  if (rawReport.schema_version !== "internal-review-report.v1" || reportStatus !== gateStatus) {
    return {
      ok: false,
      problem: internalReviewResumeProblem(
        "artifact_invalid",
        `Recorded internal review result cannot be resumed because artifact ${reportArtifactPath} does not match the recorded gate status.`,
        reportArtifactRef,
      ),
    };
  }

  const reviewerResult = rawReport.reviewer_result;
  const publicReviewerResult = isRecord(report?.reviewer_result) ? report.reviewer_result : null;
  const verdictRef = reviewerResult?.artifact_ref;
  const publicVerdictRef = publicReviewerResult?.artifact_ref;
  const verdictPath = nonEmptyString(verdictRef?.path);
  const expectedVerdictSha256 = nonEmptyString(verdictRef?.sha256);
  if (!isRecord(reviewerResult) || !verdictPath || !expectedVerdictSha256) {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_missing",
        "Recorded internal review result cannot be resumed because it does not include independent reviewer verdict artifact evidence.",
        reportArtifactRef,
      ),
    };
  }

  const reviewerStatus = nonEmptyString(reviewerResult.status).toUpperCase();
  if (reviewerStatus !== gateStatus) {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_invalid",
        "Recorded internal review result cannot be resumed because independent reviewer verdict status does not match the recorded gate status.",
        publicVerdictRef,
      ),
    };
  }

  const resolvedVerdict = resolveRecordedArtifactPath(runDir, verdictPath);
  if (!resolvedVerdict || !(resolvedVerdict.relativePath === "artifacts" || resolvedVerdict.relativePath.startsWith(`artifacts${path.sep}`))) {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_invalid",
        "Recorded internal review result cannot be resumed because the independent reviewer verdict artifact path is invalid.",
        publicVerdictRef,
      ),
    };
  }

  let verdictContent;
  try {
    verdictContent = await fs.readFile(resolvedVerdict.absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        report,
        problem: internalReviewResumeProblem(
          "independent_evidence_missing",
          `Recorded internal review result cannot be resumed because independent reviewer verdict artifact ${resolvedVerdict.relativePath} is missing on disk.`,
          publicVerdictRef,
        ),
      };
    }
    throw error;
  }

  if (sha256Hex(verdictContent) !== expectedVerdictSha256) {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_corrupt",
        `Recorded internal review result cannot be resumed because independent reviewer verdict artifact ${resolvedVerdict.relativePath} no longer matches its recorded hash.`,
        publicVerdictRef,
      ),
    };
  }

  let verdict;
  try {
    verdict = JSON.parse(verdictContent.toString("utf8"));
  } catch {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_invalid",
        `Recorded internal review result cannot be resumed because independent reviewer verdict artifact ${resolvedVerdict.relativePath} is not valid JSON.`,
        publicVerdictRef,
      ),
    };
  }

  const verdictStatus = nonEmptyString(verdict?.status).toUpperCase();
  const verdictSchema = nonEmptyString(verdict?.schema_version || verdict?.schemaVersion);
  if (!isRecord(verdict) || verdictSchema !== "internal-review-verdict.v1" || verdictStatus !== gateStatus) {
    return {
      ok: false,
      report,
      problem: internalReviewResumeProblem(
        "independent_evidence_invalid",
        `Recorded internal review result cannot be resumed because independent reviewer verdict artifact ${resolvedVerdict.relativePath} does not match the expected schema and status.`,
        publicVerdictRef,
      ),
    };
  }

  return { ok: true, report, verdict_ref: publicVerdictRef };
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
export async function runVerificationStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, clock, actor, paths, registryRepository } = {}) {
  const registry = assertRegistryRepository(registryRepository);
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

    const transitioned = await registry.transitionRun(registryRoot, runId, {
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

  const recordedArtifact = await registry.recordArtifact(registryRoot, runId, {
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

  const gateResult = await registry.recordGateResult(registryRoot, runId, {
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
  const transitioned = await registry.transitionRun(registryRoot, runId, {
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
export async function runInternalReviewStage({ registryRoot, runId, current, previousState, stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch, verification, clock, actor, paths, registryRepository } = {}) {
  const registry = assertRegistryRepository(registryRepository);
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

    const evidenceIntegrity = await inspectRecordedInternalReviewEvidence(
      paths.runDir,
      current.gates.internal_review.status,
      artifactIntegrity.artifact_refs[0] || null,
      { workspacePath: current.workspace?.path || current.locks?.workspace_path || "" },
    );
    if (!evidenceIntegrity.ok) {
      internalReview = {
        ...(isRecord(evidenceIntegrity.report) ? evidenceIntegrity.report : {}),
        status: current.gates.internal_review.status,
        artifact_ref: artifactIntegrity.artifact_refs[0] || null,
        artifact_refs: artifactIntegrity.artifact_refs,
        artifact_record_status: "noop",
        gate_result_status: "stale_recorded_result",
        resumed_recorded_result: false,
        problem: evidenceIntegrity.problem,
      };
      blockers.push(evidenceIntegrity.problem);
      stepsTaken.push(buildStep({
        action: "internal_review_resume",
        status: "blocked",
        fromState: "internal_review",
        toState: "internal_review",
        detail: evidenceIntegrity.problem.message,
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
    const artifactReport = evidenceIntegrity.report;
    internalReview = {
      ...artifactReport,
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
      detail: "Existing current-epoch internal review gate result was reused with independent reviewer verdict artifact evidence.",
    }));

    const transitioned = await registry.transitionRun(registryRoot, runId, {
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

  const recordedArtifact = await registry.recordArtifact(registryRoot, runId, {
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

  const gateResult = await registry.recordGateResult(registryRoot, runId, {
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
  const transitioned = await registry.transitionRun(registryRoot, runId, {
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
 * Records SCM handoff projection intent/result for runs already positioned in `handoff_ready`.
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
