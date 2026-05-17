import { sanitizeProjectionDurableValue } from "./projection-contract.js";
import { nonEmptyString, sha256Hex } from "./utils.js";

const PROJECTION_NAME = "github_pr";
const PROJECTION_TARGET = "github.pr";
const PROJECTION_MODE = "local_fake";
const PROJECTION_ADAPTER = "local-github-pr-projection";

function projectionContractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function projectionBaseKey(snapshot) {
  const verificationAttempt = snapshot?.gates?.verification?.current_attempt || 0;
  const internalReviewAttempt = snapshot?.gates?.internal_review?.current_attempt || 0;
  return [
    snapshot?.run_id || "",
    PROJECTION_TARGET,
    snapshot?.execution?.current_epoch || 0,
    verificationAttempt,
    internalReviewAttempt,
    snapshot?.github?.repo || "",
    snapshot?.github?.issue_number ?? "",
    snapshot?.github?.intended_branch || "",
  ].join(":");
}

function buildFakePrNumber(snapshot) {
  const digest = sha256Hex(projectionBaseKey(snapshot)).slice(0, 8);
  return 100000 + (Number.parseInt(digest, 16) % 900000);
}

function buildLocalPrUrl(repo, prNumber) {
  const safeRepo = encodeURIComponent(repo || "unknown-repo");
  return `local://github-pr/${safeRepo}/pull/${prNumber}`;
}

export function buildLocalPrProjection(snapshot, { clock = () => new Date(), actor = PROJECTION_ADAPTER } = {}) {
  const existingProjection = snapshot?.projections?.github_pr || {};
  const existingRecordedAt = existingProjection?.last_result?.recorded_at || existingProjection?.last_intent?.recorded_at || "";
  const existingActor = existingProjection?.last_result?.actor || existingProjection?.last_intent?.actor || "";
  const recordedAt = existingRecordedAt || clock().toISOString();
  const effectiveActor = existingActor || actor;
  const executionEpoch = snapshot?.execution?.current_epoch || 0;
  const verification = snapshot?.gates?.verification || {};
  const internalReview = snapshot?.gates?.internal_review || {};
  const baseKey = projectionBaseKey(snapshot);
  const keyDigest = sha256Hex(baseKey).slice(0, 16);
  const prNumber = buildFakePrNumber(snapshot);
  const repo = nonEmptyString(snapshot?.github?.repo);
  const issueNumber = snapshot?.github?.issue_number ?? null;
  const headBranch = nonEmptyString(snapshot?.github?.intended_branch);
  const baseBranch = nonEmptyString(snapshot?.github?.base_branch);
  if (!baseBranch) {
    throw projectionContractError(
      "projection_missing_base_branch",
      `Run ${snapshot?.run_id || "unknown"} cannot record a PR projection because github.base_branch is missing from the approved local contract.`,
    );
  }
  const sanitizedTaskId = sanitizeProjectionDurableValue(snapshot?.task_id || snapshot?.run_id || "task");
  const githubPr = sanitizeProjectionDurableValue({
    number: prNumber,
    url: buildLocalPrUrl(repo, prNumber),
    repo,
    issue_number: issueNumber,
    head_branch: headBranch,
    base_branch: baseBranch,
    state: "open",
    draft: false,
    title: `Buran handoff for ${sanitizedTaskId}`,
    projection_mode: PROJECTION_MODE,
    projected_at: recordedAt,
    actor: effectiveActor,
  });

  const intentIdempotencyKey = `${baseKey}:intent`;
  const resultIdempotencyKey = `${baseKey}:result`;
  const intentArtifactPath = `artifacts/pr/projection-intent-${keyDigest}.json`;
  const resultArtifactPath = `artifacts/pr/projection-result-${keyDigest}.json`;

  const intent = sanitizeProjectionDurableValue({
    schema_version: "github-pr-projection-intent.v1",
    projection_name: PROJECTION_NAME,
    projection_target: PROJECTION_TARGET,
    adapter: PROJECTION_ADAPTER,
    mode: PROJECTION_MODE,
    run_id: snapshot?.run_id || "",
    task_id: snapshot?.task_id || "",
    state: snapshot?.state || "",
    repo,
    issue_number: issueNumber,
    execution_epoch: executionEpoch,
    idempotency_key: intentIdempotencyKey,
    verification_gate: {
      status: verification.status || "",
      current_epoch: verification.current_epoch || 0,
      current_attempt: verification.current_attempt || 0,
      artifact_refs: verification.artifact_refs || [],
    },
    internal_review_gate: {
      status: internalReview.status || "",
      current_epoch: internalReview.current_epoch || 0,
      current_attempt: internalReview.current_attempt || 0,
      artifact_refs: internalReview.artifact_refs || [],
    },
    intended_pr: {
      repo,
      issue_number: issueNumber,
      head_branch: headBranch,
      base_branch: baseBranch,
      title: githubPr.title,
      projection_mode: PROJECTION_MODE,
    },
    source_of_truth: "local_registry",
    recorded_at: recordedAt,
    actor: effectiveActor,
  });

  const result = sanitizeProjectionDurableValue({
    schema_version: "github-pr-projection-result.v1",
    projection_name: PROJECTION_NAME,
    projection_target: PROJECTION_TARGET,
    adapter: PROJECTION_ADAPTER,
    mode: PROJECTION_MODE,
    run_id: snapshot?.run_id || "",
    task_id: snapshot?.task_id || "",
    state: snapshot?.state || "",
    repo,
    issue_number: issueNumber,
    execution_epoch: executionEpoch,
    status: "projected_local",
    idempotency_key: resultIdempotencyKey,
    intent_idempotency_key: intentIdempotencyKey,
    verification_gate: intent.verification_gate,
    internal_review_gate: intent.internal_review_gate,
    github_pr: githubPr,
    source_of_truth: "local_registry",
    projected_at: recordedAt,
    actor: effectiveActor,
  });

  return {
    adapter: PROJECTION_ADAPTER,
    mode: PROJECTION_MODE,
    projectionName: PROJECTION_NAME,
    projectionTarget: PROJECTION_TARGET,
    executionEpoch,
    recordedAt,
    actor: effectiveActor,
    intentIdempotencyKey,
    resultIdempotencyKey,
    intentArtifactPath,
    resultArtifactPath,
    intentArtifactContent: `${JSON.stringify(intent, null, 2)}\n`,
    resultArtifactContent: `${JSON.stringify(result, null, 2)}\n`,
    intent,
    result,
    githubPr,
    publicReport: {
      status: result.status,
      adapter: PROJECTION_ADAPTER,
      mode: PROJECTION_MODE,
      github_pr: githubPr,
      intent_idempotency_key: intentIdempotencyKey,
      result_idempotency_key: resultIdempotencyKey,
    },
  };
}
