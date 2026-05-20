/**
 * Stack workflow policy helpers for enforcing review-ready progression.
 *
 * Responsibility:
 * - decide whether a completed slice/run is ready to unblock the next stacked slice,
 * - expose per-gate status for operator reports,
 * - keep the decision derived from durable local registry state, not remote comments.
 *
 * Non-goals:
 * - no GitHub writes, merges, or issue/project automation,
 * - no recovery mutation; recovery callers re-evaluate this policy from replayed snapshots.
 */
import { GATE_STATUS } from "../execution-runs/constants.js";
import {
  appendGithubPrContractErrors,
  appendGithubPrValidationErrors,
  appendProjectedPrParityErrors,
  isSuccessfulProjectionResultStatus,
} from "../workflow-boundary/pr-scm-projection/contract.js";
import { sanitizePublicReportForOutput } from "../observability/index.js";
import { isRecord, nonEmptyString } from "../shared/primitives.js";

export const WORKFLOW_POLICY_SCHEMA_VERSION = "buran-workflow-policy.v1";

function publicValue(value) {
  return sanitizePublicReportForOutput(value, []);
}

function artifactRefOk(ref) {
  return nonEmptyString(ref?.path) && nonEmptyString(ref?.sha256);
}

function recordedArtifacts(snapshot) {
  const byPath = snapshot?.artifacts?.recorded?.by_path;
  return isRecord(byPath) ? Object.values(byPath) : [];
}

function hasRecordedArtifact(snapshot, gateName, predicate = () => true) {
  return recordedArtifacts(snapshot).some((artifact) => artifact?.gate_name === gateName && artifactRefOk(artifact) && predicate(artifact));
}

function completedImplementationEvidence(artifact) {
  const provenance = artifact?.provenance;
  return (provenance?.kind === "implementation-dispatch-result" || provenance?.kind === "fix-attempt-result")
    && provenance?.status === "COMPLETED";
}

function gate(name, ok, detail, evidence = {}) {
  return {
    name,
    status: ok ? "PASS" : "BLOCKED",
    detail: publicValue(detail),
    evidence: publicValue(evidence),
  };
}

function currentEpoch(snapshot) {
  return Number.isSafeInteger(snapshot?.execution?.current_epoch) ? snapshot.execution.current_epoch : 0;
}

function freshGatePassed(snapshot, gateName) {
  const epoch = currentEpoch(snapshot);
  const gateHead = snapshot?.gates?.[gateName];
  return epoch >= 1
    && gateHead?.status === GATE_STATUS.PASS
    && gateHead.current_epoch === epoch
    && Number.isSafeInteger(gateHead.current_attempt)
    && gateHead.current_attempt >= 1
    && Array.isArray(gateHead.artifact_refs)
    && gateHead.artifact_refs.length > 0
    && gateHead.artifact_refs.every(artifactRefOk);
}

function decodedPathParts(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function appendGithubPrUrlBindingErrors(githubPr, errors, fieldPath) {
  const repo = nonEmptyString(githubPr?.repo);
  const url = nonEmptyString(githubPr?.url);
  const number = Number.isSafeInteger(githubPr?.number) && githubPr.number >= 1 ? githubPr.number : null;
  if (!repo || !url || number === null) return;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  const expectedNumber = String(number);
  const parts = decodedPathParts(parsed.pathname);
  if (parsed.protocol === "local:") {
    const matches = parsed.hostname === "github-pr"
      && !parsed.search
      && !parsed.hash
      && parts.length === 3
      && parts[0] === repo
      && parts[1] === "pull"
      && parts[2] === expectedNumber;
    if (!matches) errors.push(`${fieldPath}.url must bind to local github-pr repo and PR number`);
    return;
  }

  const repoParts = repo.split("/").filter(Boolean);
  const matches = parsed.protocol === "https:"
    && parsed.host.toLowerCase() === "github.com"
    && !parsed.search
    && !parsed.hash
    && repoParts.length === 2
    && parts.length === 4
    && parts[0] === repoParts[0]
    && parts[1] === repoParts[1]
    && parts[2] === "pull"
    && parts[3] === expectedNumber;
  if (!matches) errors.push(`${fieldPath}.url must bind to https://github.com repo and PR number`);
}

function appendProjectionGithubPrErrors(snapshot, githubPr, errors, fieldPath) {
  appendGithubPrValidationErrors(githubPr, errors, fieldPath);
  if (!isRecord(githubPr)) return;
  appendGithubPrContractErrors(snapshot, githubPr, errors, fieldPath);
  appendGithubPrUrlBindingErrors(githubPr, errors, fieldPath);
}

function projectionParityErrors(pr, resultPr) {
  const errors = [];
  if (!isRecord(resultPr)) {
    errors.push("projections.github_pr.last_result.github_pr must be present.");
    return errors;
  }
  appendProjectedPrParityErrors(pr, resultPr, errors);
  return errors;
}

function projectionReadiness(snapshot) {
  const projection = snapshot?.projections?.github_pr;
  const result = projection?.last_result;
  const pr = snapshot?.github?.pr;
  const epoch = currentEpoch(snapshot);
  const errors = [];

  if (!isRecord(projection)) errors.push("projections.github_pr must be present.");
  if (isRecord(projection) && projection.execution_epoch !== epoch) errors.push("projections.github_pr.execution_epoch must match the current epoch.");
  if (!isRecord(result)) errors.push("projections.github_pr.last_result must be present.");
  if (isRecord(result) && result.execution_epoch !== epoch) errors.push("projections.github_pr.last_result.execution_epoch must match the current epoch.");
  if (isRecord(result) && result.recorded_from_state !== "pr_ready") errors.push("projections.github_pr.last_result.recorded_from_state must be pr_ready.");
  if (isRecord(result) && !isSuccessfulProjectionResultStatus(result.status)) errors.push("projections.github_pr.last_result.status must be successful.");
  if (isRecord(result) && !artifactRefOk(result.artifact_ref)) errors.push("projections.github_pr.last_result.artifact_ref must be recorded.");
  if (isRecord(result) && !nonEmptyString(result.idempotency_key)) errors.push("projections.github_pr.last_result.idempotency_key must be recorded.");
  const intent = projection?.last_intent;
  if (isRecord(intent)) {
    if (intent.execution_epoch !== epoch) errors.push("projections.github_pr.last_intent.execution_epoch must match the current epoch.");
    if (intent.recorded_from_state !== "pr_ready") errors.push("projections.github_pr.last_intent.recorded_from_state must be pr_ready.");
    if (!artifactRefOk(intent.artifact_ref)) errors.push("projections.github_pr.last_intent.artifact_ref must be recorded.");
    if (!nonEmptyString(intent.idempotency_key)) errors.push("projections.github_pr.last_intent.idempotency_key must be recorded.");
    if (isRecord(result) && nonEmptyString(result.intent_idempotency_key) && result.intent_idempotency_key !== intent.idempotency_key) {
      errors.push("projections.github_pr.last_result.intent_idempotency_key must match projections.github_pr.last_intent.idempotency_key.");
    }
  }

  if (!isRecord(pr)) {
    errors.push("github.pr must be present.");
  } else {
    appendProjectionGithubPrErrors(snapshot, pr, errors, "github.pr");
  }

  if (isRecord(result?.github_pr)) {
    appendProjectionGithubPrErrors(snapshot, result.github_pr, errors, "projections.github_pr.last_result.github_pr");
  }
  if (isRecord(pr) && isRecord(result)) errors.push(...projectionParityErrors(pr, result.github_pr));
  return { ready: errors.length === 0, errors };
}

function successfulProjection(snapshot) {
  return projectionReadiness(snapshot).ready;
}

function gateBlocker(gateStatus) {
  return {
    code: `workflow_${gateStatus.name}_not_ready`,
    message: gateStatus.detail,
    gate: gateStatus.name,
    status: gateStatus.status,
  };
}

/**
 * Evaluates whether a current slice/run is review-ready and can unblock the next slice.
 *
 * @param {object} snapshot Durable ExecutionRun snapshot for the prerequisite slice.
 * @param {object} [options]
 * @param {string} [options.currentSlice=""] Human-readable current slice label.
 * @param {string} [options.nextSlice=""] Human-readable next slice label.
 * @returns {object} Public-safe policy report with per-gate status.
 */
export function evaluateReviewReadyPolicy(snapshot, { currentSlice = "", nextSlice = "" } = {}) {
  const epoch = currentEpoch(snapshot);
  const packetReady = artifactRefOk(snapshot?.artifacts?.packet);
  const implementationReady = hasRecordedArtifact(
    snapshot,
    "implementation_dispatch",
    (artifact) => completedImplementationEvidence(artifact) && (artifact.execution_epoch === 0 || artifact.execution_epoch === epoch),
  ) || hasRecordedArtifact(
    snapshot,
    "fix_attempt",
    (artifact) => completedImplementationEvidence(artifact) && artifact.execution_epoch === epoch,
  );
  const verificationReady = freshGatePassed(snapshot, "verification");
  const reviewReady = freshGatePassed(snapshot, "internal_review");
  const projectionReadinessResult = projectionReadiness(snapshot);
  const projectionReady = successfulProjection(snapshot);
  const terminalReady = snapshot?.state === "ready_for_manual_review";

  const gates = [
    gate("architect_contract", packetReady, packetReady
      ? "Approved packet/architect contract artifact is present."
      : "Approved packet/architect contract artifact is missing.", {
        artifact_ref: snapshot?.artifacts?.packet || null,
      }),
    gate("implementation_handoff", implementationReady, implementationReady
      ? "Completed implementation dispatch/fix evidence is recorded in the local artifact ledger."
      : "Completed implementation dispatch/fix result evidence is missing from the local artifact ledger.", {
        current_epoch: epoch,
      }),
    gate("verification", verificationReady, verificationReady
      ? "Fresh current-epoch verification PASS is recorded with artifact evidence."
      : "Fresh current-epoch verification PASS with artifact evidence is required.", {
        gate: snapshot?.gates?.verification || null,
      }),
    gate("independent_review", reviewReady, reviewReady
      ? "Fresh current-epoch independent internal-review PASS is recorded with artifact evidence."
      : "Fresh current-epoch independent internal-review PASS with artifact evidence is required.", {
        gate: snapshot?.gates?.internal_review || null,
      }),
    gate("pr_projection", projectionReady, projectionReady
      ? "PR projection result is recorded and mirrored into github.pr."
      : "A successful current-epoch PR projection result that matches github.pr is required before starting the next slice.", {
        projection: snapshot?.projections?.github_pr || null,
        github_pr: snapshot?.github?.pr || null,
        parity_errors: projectionReadinessResult.errors,
      }),
    gate("review_ready_terminal_state", terminalReady, terminalReady
      ? "Run is terminal in ready_for_manual_review."
      : "Run must be terminal in ready_for_manual_review before the next slice starts.", {
        state: snapshot?.state || "",
      }),
  ];

  const blockers = gates.filter((item) => item.status !== "PASS").map(gateBlocker);
  const allowed = blockers.length === 0;
  return publicValue({
    schema_version: WORKFLOW_POLICY_SCHEMA_VERSION,
    status: allowed ? "review_ready" : "blocked",
    allowed_to_start_next_slice: allowed,
    current_slice: nonEmptyString(currentSlice),
    next_slice: nonEmptyString(nextSlice),
    prerequisite_run_id: snapshot?.run_id || "",
    prerequisite_state: snapshot?.state || "",
    current_epoch: epoch,
    gates,
    blockers,
  });
}

/**
 * Throws when a prerequisite slice is not review-ready.
 *
 * @param {object} snapshot Durable ExecutionRun snapshot for the prerequisite slice.
 * @param {object} [options] Labels forwarded to evaluateReviewReadyPolicy.
 * @returns {object} Passing policy report.
 * @throws {Error & {code: string, policy: object}}
 */
export function assertNextSliceAllowed(snapshot, options = {}) {
  const policy = evaluateReviewReadyPolicy(snapshot, options);
  if (policy.allowed_to_start_next_slice) return policy;
  const first = policy.blockers[0] || { message: "Prerequisite slice is not review-ready." };
  const error = new Error(first.message);
  error.code = "stack_prerequisite_not_review_ready";
  error.policy = policy;
  throw error;
}
