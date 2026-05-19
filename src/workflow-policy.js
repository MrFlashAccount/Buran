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
import { GATE_STATUS } from "./constants.js";
import { isSuccessfulProjectionResultStatus } from "./projection-contract.js";
import { sanitizePublicReportForOutput } from "./observability.js";
import { isRecord, nonEmptyString } from "./utils.js";

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

function successfulProjection(snapshot) {
  const projection = snapshot?.projections?.github_pr;
  const result = projection?.last_result;
  const pr = snapshot?.github?.pr;
  const epoch = currentEpoch(snapshot);
  return isRecord(projection)
    && isRecord(result)
    && result.execution_epoch === epoch
    && result.recorded_from_state === "pr_ready"
    && isSuccessfulProjectionResultStatus(result.status)
    && artifactRefOk(result.artifact_ref)
    && nonEmptyString(result.idempotency_key)
    && isRecord(pr)
    && Number.isSafeInteger(pr.number)
    && pr.number > 0
    && nonEmptyString(pr.url)
    && nonEmptyString(pr.head_branch)
    && nonEmptyString(pr.base_branch);
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
      : "A successful current-epoch PR projection result is required before starting the next slice.", {
        projection: snapshot?.projections?.github_pr || null,
        github_pr: snapshot?.github?.pr || null,
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
