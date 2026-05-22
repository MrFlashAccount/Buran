/** Provider-neutral SCM handoff planning/result/read-model helpers. */
import {
  appendScmHandoffTargetContractErrors,
  appendScmHandoffTargetValidationErrors,
  sanitizeProjectionDurableValue,
} from "../contract.js";
import { projectionContractError } from "../errors.js";
import { nonEmptyString, sha256Hex } from "../../../../shared/primitives.js";

const PROJECTION_NAME = "handoff_target";
const PROJECTION_TARGET = "handoff_target";
export const LOCAL_SCM_HANDOFF_MODE = "local_fake";
export const LOCAL_SCM_HANDOFF_ADAPTER = "local-scm-handoff";
export const LOCAL_JOURNAL_SCM_HANDOFF_ADAPTER = LOCAL_SCM_HANDOFF_ADAPTER;

function scmTarget(snapshot) {
  if (snapshot?.scm_target && typeof snapshot.scm_target === "object") return snapshot.scm_target;
  return snapshot?.github && typeof snapshot.github === "object" ? snapshot.github : {};
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
    scmTarget(snapshot).repo || "",
    scmTarget(snapshot).issue_number ?? "",
    scmTarget(snapshot).intended_branch || "",
    scmTarget(snapshot).base_branch || "",
  ].join(":");
}

function buildFakeHandoffNumber(snapshot) {
  const digest = sha256Hex(projectionBaseKey(snapshot)).slice(0, 8);
  return 100000 + (Number.parseInt(digest, 16) % 900000);
}

function buildLocalHandoffUrl(repo, targetNumber) {
  const safeRepo = encodeURIComponent(repo || "unknown-repo");
  return `local://scm-handoff/${safeRepo}/target/${targetNumber}`;
}

function gateSummary(gate = {}) {
  return {
    status: gate.status || "",
    current_epoch: gate.current_epoch || 0,
    current_attempt: gate.current_attempt || 0,
    artifact_refs: gate.artifact_refs || [],
  };
}

function existingProjection(snapshot) {
  return snapshot?.projection_ledger?.handoff_target || {};
}

function existingProjectionRecordedAt(snapshot) {
  const projection = existingProjection(snapshot);
  return projection?.last_result?.recorded_at || projection?.last_intent?.recorded_at || "";
}

function existingProjectionActor(snapshot) {
  const projection = existingProjection(snapshot);
  return projection?.last_result?.actor || projection?.last_intent?.actor || "";
}

function requireBaseBranch(snapshot) {
  const baseBranch = nonEmptyString(scmTarget(snapshot).base_branch);
  if (!baseBranch) {
    throw projectionContractError(
      "projection_missing_base_branch",
      `Run ${snapshot?.run_id || "unknown"} cannot record an SCM handoff projection because scm_target.base_branch is missing from the approved local contract.`,
    );
  }
  return baseBranch;
}

function projectionTitle(snapshot) {
  const sanitizedTaskId = sanitizeProjectionDurableValue(snapshot?.task_id || snapshot?.run_id || "task");
  return `Buran handoff for ${sanitizedTaskId}`;
}

/**
 * Builds a deterministic SCM handoff plan from the current run snapshot.
 *
 * The returned plan is used both for intent recording and for later result recording so
 * idempotency keys, artifact paths, and contract expectations stay aligned.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} [options]
 * @param {() => Date} [options.clock=() => new Date()] Clock source used for recorded timestamps.
 * @param {string} [options.actor=LOCAL_SCM_HANDOFF_ADAPTER] Actor recorded on projection artifacts.
 * @param {string} [options.adapter=LOCAL_SCM_HANDOFF_ADAPTER] Adapter identifier recorded in projection artifacts.
 * @param {string} [options.mode=LOCAL_SCM_HANDOFF_MODE] Projection mode label recorded in projection artifacts.
 * @param {boolean} [options.externalSideEffects=false] Whether downstream execution performs remote writes.
 * @returns {object} Projection plan with immutable intent/result metadata and contract expectations.
 * @throws {Error & {code: string}} When the snapshot does not contain a required base branch.
 */
export function buildScmHandoffPlan(snapshot, {
  clock = () => new Date(),
  actor = LOCAL_SCM_HANDOFF_ADAPTER,
  adapter = LOCAL_SCM_HANDOFF_ADAPTER,
  mode = LOCAL_SCM_HANDOFF_MODE,
  externalSideEffects = false,
} = {}) {
  const recordedAt = existingProjectionRecordedAt(snapshot) || clock().toISOString();
  const effectiveActor = existingProjectionActor(snapshot) || actor;
  const executionEpoch = snapshot?.execution?.current_epoch || 0;
  const verification = gateSummary(snapshot?.gates?.verification || {});
  const internalReview = gateSummary(snapshot?.gates?.internal_review || {});
  const baseKey = projectionBaseKey(snapshot);
  const idempotencyDigest = sha256Hex(baseKey);
  const artifactDigest = idempotencyDigest.slice(0, 16);
  const target = scmTarget(snapshot);
  const repo = nonEmptyString(target.repo);
  const issueNumber = target.issue_number ?? null;
  const headBranch = nonEmptyString(target.intended_branch);
  const baseBranch = requireBaseBranch(snapshot);
  const title = projectionTitle(snapshot);

  const intentIdempotencyKey = `${PROJECTION_TARGET}:${idempotencyDigest}:intent`;
  const resultIdempotencyKey = `${PROJECTION_TARGET}:${idempotencyDigest}:result`;
  const intentArtifactPath = `artifacts/scm-handoff/intent-${artifactDigest}.json`;
  const resultArtifactPath = `artifacts/scm-handoff/result-${artifactDigest}.json`;

  const intent = sanitizeProjectionDurableValue({
    schema_version: "scm-handoff-intent.v1",
    projection_name: PROJECTION_NAME,
    projection_target: PROJECTION_TARGET,
    adapter,
    mode,
    run_id: snapshot?.run_id || "",
    task_id: snapshot?.task_id || "",
    state: snapshot?.state || "",
    repo,
    issue_number: issueNumber,
    execution_epoch: executionEpoch,
    idempotency_key: intentIdempotencyKey,
    verification_gate: verification,
    internal_review_gate: internalReview,
    intended_handoff_target: {
      repo,
      issue_number: issueNumber,
      head_branch: headBranch,
      base_branch: baseBranch,
      title,
      projection_mode: mode,
    },
    source_of_truth: "local_registry",
    recorded_at: recordedAt,
    actor: effectiveActor,
  });

  return {
    adapter,
    mode,
    projectionName: PROJECTION_NAME,
    projectionTarget: PROJECTION_TARGET,
    executionEpoch,
    recordedAt,
    actor: effectiveActor,
    repo,
    issueNumber,
    headBranch,
    baseBranch,
    title,
    intentIdempotencyKey,
    resultIdempotencyKey,
    intentArtifactPath,
    resultArtifactPath,
    verificationGate: verification,
    internalReviewGate: internalReview,
    intent,
    intentArtifactContent: `${JSON.stringify(intent, null, 2)}\n`,
    externalSideEffects: Boolean(externalSideEffects),
  };
}

function validateHandoffTargetAgainstContract(snapshot, handoffTarget, { durable = false } = {}) {
  const errors = [];
  appendScmHandoffTargetValidationErrors(handoffTarget, errors, "projection.handoff_target");
  appendScmHandoffTargetContractErrors(snapshot, handoffTarget, errors, "projection.handoff_target", { durable });
  if (errors.length > 0) {
    throw projectionContractError("projection_invalid_handoff_target", errors.join("; "));
  }
}

function validateSanitizedHandoffTarget(handoffTarget) {
  const errors = [];
  appendScmHandoffTargetValidationErrors(handoffTarget, errors, "projection.handoff_target");
  if (errors.length > 0) {
    throw projectionContractError("projection_invalid_handoff_target", errors.join("; "));
  }
}

/**
 * Builds a validated SCM handoff result artifact from a plan plus concrete handoff data.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} plan Projection plan previously produced for the same snapshot.
 * @param {object} options
 * @param {string} options.status Projection status to record.
 * @param {object} options.handoffTarget Contract-bearing handoff payload.
 * @param {string} [options.actor=plan.actor] Actor recorded on the result artifact.
 * @param {string} [options.recordedAt=plan.recordedAt] Timestamp recorded on the result artifact.
 * @param {boolean} [options.externalSideEffects=plan.externalSideEffects] Whether transport-side effects occurred.
 * @param {boolean} [options.durableContract=false] Whether to sanitize expected snapshot values before parity checks.
 * @returns {object} Projection result package ready for durable recording.
 * @throws {Error & {code: string}} When the projected handoff payload violates schema or contract expectations.
 */
export function buildScmHandoffResult(snapshot, plan, {
  status,
  handoffTarget,
  actor = plan.actor,
  recordedAt = plan.recordedAt,
  externalSideEffects = plan.externalSideEffects,
  durableContract = false,
} = {}) {
  validateHandoffTargetAgainstContract(snapshot, handoffTarget, { durable: durableContract });
  const effectiveHandoffTarget = sanitizeProjectionDurableValue(handoffTarget);
  validateSanitizedHandoffTarget(effectiveHandoffTarget);

  const result = sanitizeProjectionDurableValue({
    schema_version: "scm-handoff-result.v1",
    projection_name: plan.projectionName,
    projection_target: plan.projectionTarget,
    adapter: plan.adapter,
    mode: plan.mode,
    run_id: snapshot?.run_id || "",
    task_id: snapshot?.task_id || "",
    state: snapshot?.state || "",
    repo: plan.repo,
    issue_number: plan.issueNumber,
    execution_epoch: plan.executionEpoch,
    status,
    idempotency_key: plan.resultIdempotencyKey,
    intent_idempotency_key: plan.intentIdempotencyKey,
    verification_gate: plan.verificationGate,
    internal_review_gate: plan.internalReviewGate,
    handoff_target: effectiveHandoffTarget,
    source_of_truth: "local_registry",
    projected_at: recordedAt,
    actor,
  });

  return {
    ...plan,
    actor,
    recordedAt,
    result,
    handoffTarget: effectiveHandoffTarget,
    resultArtifactContent: `${JSON.stringify(result, null, 2)}\n`,
    publicReport: {
      status: result.status,
      adapter: plan.adapter,
      mode: plan.mode,
      handoff_target: effectiveHandoffTarget,
      intent_idempotency_key: plan.intentIdempotencyKey,
      result_idempotency_key: plan.resultIdempotencyKey,
    },
    externalSideEffects: Boolean(externalSideEffects),
  };
}

/**
 * Rehydrates the latest successful recorded SCM handoff projection from the run snapshot.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} [options]
 * @param {() => Date} [options.clock=() => new Date()] Clock source used when rebuilding the base plan.
 * @param {string} [options.expectedAdapter=""] Optional adapter filter; mismatches return `null`.
 * @param {string} [options.expectedMode=""] Optional mode filter; mismatches return `null`.
 * @param {boolean} [options.externalSideEffects=false] Whether the recovered projection should report remote writes.
 * @returns {object|null} Rebuilt projection result, or `null` when no compatible recorded result exists.
 */
export function buildRecordedScmHandoff(snapshot, {
  clock = () => new Date(),
  expectedAdapter = "",
  expectedMode = "",
  externalSideEffects = false,
} = {}) {
  const projection = existingProjection(snapshot);
  const lastResult = projection?.last_result;
  if (!lastResult?.status || !lastResult?.handoff_target) return null;
  if (expectedAdapter && projection?.adapter !== expectedAdapter) return null;
  if (expectedMode && projection?.mode !== expectedMode) return null;

  const plan = buildScmHandoffPlan(snapshot, {
    clock,
    actor: lastResult.actor || projection?.last_intent?.actor || LOCAL_SCM_HANDOFF_ADAPTER,
    adapter: projection?.adapter || expectedAdapter || LOCAL_SCM_HANDOFF_ADAPTER,
    mode: projection?.mode || expectedMode || LOCAL_SCM_HANDOFF_MODE,
    externalSideEffects,
  });

  return buildScmHandoffResult(snapshot, plan, {
    status: lastResult.status,
    handoffTarget: lastResult.handoff_target,
    actor: lastResult.actor || plan.actor,
    recordedAt: lastResult.recorded_at || plan.recordedAt,
    externalSideEffects,
    durableContract: true,
  });
}

