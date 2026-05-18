/**
 * Local PR projection planning/execution helpers for turning a reviewed run into `github.pr` data.
 *
 * Responsibility:
 * - derive deterministic PR projection intent/result artifacts from the local run contract,
 * - validate that projected PR data matches repo/issue/branch expectations,
 * - provide a no-network local adapter for manual-review handoff flows.
 *
 * Non-goals:
 * - no direct GitHub writes in the local adapter,
 * - no projection when base-branch contract data is missing,
 * - no acceptance of unsanitized durable PR payloads.
 */
import {
  appendGithubPrContractErrors,
  appendGithubPrValidationErrors,
  sanitizeProjectionDurableValue,
} from "./projection-contract.js";
import { nonEmptyString, sha256Hex } from "./utils.js";

const PROJECTION_NAME = "github_pr";
const PROJECTION_TARGET = "github.pr";
export const LOCAL_PR_PROJECTION_MODE = "local_fake";
export const LOCAL_PR_PROJECTION_ADAPTER = "local-github-pr-projection";

/**
 * Builds a typed error used when projection data violates the documented local contract.
 *
 * @param {string} code Stable machine-readable error code.
 * @param {string} message Public-safe explanation.
 * @returns {Error & {code: string}}
 */
export function projectionContractError(code, message) {
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

function gateSummary(gate = {}) {
  return {
    status: gate.status || "",
    current_epoch: gate.current_epoch || 0,
    current_attempt: gate.current_attempt || 0,
    artifact_refs: gate.artifact_refs || [],
  };
}

function existingProjection(snapshot) {
  return snapshot?.projections?.github_pr || {};
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
  const baseBranch = nonEmptyString(snapshot?.github?.base_branch);
  if (!baseBranch) {
    throw projectionContractError(
      "projection_missing_base_branch",
      `Run ${snapshot?.run_id || "unknown"} cannot record a PR projection because github.base_branch is missing from the approved local contract.`,
    );
  }
  return baseBranch;
}

function projectionTitle(snapshot) {
  const sanitizedTaskId = sanitizeProjectionDurableValue(snapshot?.task_id || snapshot?.run_id || "task");
  return `Buran handoff for ${sanitizedTaskId}`;
}

/**
 * Builds a deterministic PR projection plan from the current run snapshot.
 *
 * The returned plan is used both for intent recording and for later result recording so
 * idempotency keys, artifact paths, and contract expectations stay aligned.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} [options]
 * @param {() => Date} [options.clock=() => new Date()] Clock source used for recorded timestamps.
 * @param {string} [options.actor=LOCAL_PR_PROJECTION_ADAPTER] Actor recorded on projection artifacts.
 * @param {string} [options.adapter=LOCAL_PR_PROJECTION_ADAPTER] Adapter identifier recorded in projection artifacts.
 * @param {string} [options.mode=LOCAL_PR_PROJECTION_MODE] Projection mode label recorded in projection artifacts.
 * @param {boolean} [options.externalSideEffects=false] Whether downstream execution performs remote writes.
 * @returns {object} Projection plan with immutable intent/result metadata and contract expectations.
 * @throws {Error & {code: string}} When the snapshot does not contain a required base branch.
 */
export function buildPrProjectionPlan(snapshot, {
  clock = () => new Date(),
  actor = LOCAL_PR_PROJECTION_ADAPTER,
  adapter = LOCAL_PR_PROJECTION_ADAPTER,
  mode = LOCAL_PR_PROJECTION_MODE,
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
  const repo = nonEmptyString(snapshot?.github?.repo);
  const issueNumber = snapshot?.github?.issue_number ?? null;
  const headBranch = nonEmptyString(snapshot?.github?.intended_branch);
  const baseBranch = requireBaseBranch(snapshot);
  const title = projectionTitle(snapshot);

  const intentIdempotencyKey = `${PROJECTION_TARGET}:${idempotencyDigest}:intent`;
  const resultIdempotencyKey = `${PROJECTION_TARGET}:${idempotencyDigest}:result`;
  const intentArtifactPath = `artifacts/pr/projection-intent-${artifactDigest}.json`;
  const resultArtifactPath = `artifacts/pr/projection-result-${artifactDigest}.json`;

  const intent = sanitizeProjectionDurableValue({
    schema_version: "github-pr-projection-intent.v1",
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
    intended_pr: {
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

function validateGithubPrAgainstContract(snapshot, githubPr, { durable = false } = {}) {
  const errors = [];
  appendGithubPrValidationErrors(githubPr, errors, "projection.github_pr");
  appendGithubPrContractErrors(snapshot, githubPr, errors, "projection.github_pr", { durable });
  if (errors.length > 0) {
    throw projectionContractError("projection_invalid_github_pr", errors.join("; "));
  }
}

function validateSanitizedGithubPr(githubPr) {
  const errors = [];
  appendGithubPrValidationErrors(githubPr, errors, "projection.github_pr");
  if (errors.length > 0) {
    throw projectionContractError("projection_invalid_github_pr", errors.join("; "));
  }
}

/**
 * Builds a validated PR projection result artifact from a plan plus concrete PR data.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} plan Projection plan previously produced for the same snapshot.
 * @param {object} options
 * @param {string} options.status Projection status to record.
 * @param {object} options.githubPr Contract-bearing PR payload.
 * @param {string} [options.actor=plan.actor] Actor recorded on the result artifact.
 * @param {string} [options.recordedAt=plan.recordedAt] Timestamp recorded on the result artifact.
 * @param {boolean} [options.externalSideEffects=plan.externalSideEffects] Whether transport-side effects occurred.
 * @param {boolean} [options.durableContract=false] Whether to sanitize expected snapshot values before parity checks.
 * @returns {object} Projection result package ready for durable recording.
 * @throws {Error & {code: string}} When the projected PR payload violates schema or contract expectations.
 */
export function buildPrProjectionResult(snapshot, plan, {
  status,
  githubPr,
  actor = plan.actor,
  recordedAt = plan.recordedAt,
  externalSideEffects = plan.externalSideEffects,
  durableContract = false,
} = {}) {
  validateGithubPrAgainstContract(snapshot, githubPr, { durable: durableContract });
  const effectiveGithubPr = sanitizeProjectionDurableValue(githubPr);
  validateSanitizedGithubPr(effectiveGithubPr);

  const result = sanitizeProjectionDurableValue({
    schema_version: "github-pr-projection-result.v1",
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
    github_pr: effectiveGithubPr,
    source_of_truth: "local_registry",
    projected_at: recordedAt,
    actor,
  });

  return {
    ...plan,
    actor,
    recordedAt,
    result,
    githubPr: effectiveGithubPr,
    resultArtifactContent: `${JSON.stringify(result, null, 2)}\n`,
    publicReport: {
      status: result.status,
      adapter: plan.adapter,
      mode: plan.mode,
      github_pr: effectiveGithubPr,
      intent_idempotency_key: plan.intentIdempotencyKey,
      result_idempotency_key: plan.resultIdempotencyKey,
    },
    externalSideEffects: Boolean(externalSideEffects),
  };
}

/**
 * Rehydrates the latest successful recorded PR projection from the run snapshot.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} [options]
 * @param {() => Date} [options.clock=() => new Date()] Clock source used when rebuilding the base plan.
 * @param {string} [options.expectedAdapter=""] Optional adapter filter; mismatches return `null`.
 * @param {string} [options.expectedMode=""] Optional mode filter; mismatches return `null`.
 * @param {boolean} [options.externalSideEffects=false] Whether the recovered projection should report remote writes.
 * @returns {object|null} Rebuilt projection result, or `null` when no compatible recorded result exists.
 */
export function buildRecordedPrProjection(snapshot, {
  clock = () => new Date(),
  expectedAdapter = "",
  expectedMode = "",
  externalSideEffects = false,
} = {}) {
  const projection = existingProjection(snapshot);
  const lastResult = projection?.last_result;
  if (!lastResult?.status || !lastResult?.github_pr) return null;
  if (expectedAdapter && projection?.adapter !== expectedAdapter) return null;
  if (expectedMode && projection?.mode !== expectedMode) return null;

  const plan = buildPrProjectionPlan(snapshot, {
    clock,
    actor: lastResult.actor || projection?.last_intent?.actor || LOCAL_PR_PROJECTION_ADAPTER,
    adapter: projection?.adapter || expectedAdapter || LOCAL_PR_PROJECTION_ADAPTER,
    mode: projection?.mode || expectedMode || LOCAL_PR_PROJECTION_MODE,
    externalSideEffects,
  });

  return buildPrProjectionResult(snapshot, plan, {
    status: lastResult.status,
    githubPr: lastResult.github_pr,
    actor: lastResult.actor || plan.actor,
    recordedAt: lastResult.recorded_at || plan.recordedAt,
    externalSideEffects,
    durableContract: true,
  });
}

function buildLocalGithubPr(snapshot, plan) {
  const prNumber = buildFakePrNumber(snapshot);
  return {
    number: prNumber,
    url: buildLocalPrUrl(plan.repo, prNumber),
    repo: plan.repo,
    issue_number: plan.issueNumber,
    head_branch: plan.headBranch,
    base_branch: plan.baseBranch,
    state: "open",
    draft: false,
    title: plan.title,
    projection_mode: plan.mode,
    projected_at: plan.recordedAt,
    actor: plan.actor,
  };
}

/**
 * Creates the deterministic no-network projection adapter used by local runner flows.
 *
 * @returns {{adapter: string, mode: string, externalSideEffects: boolean, plan(snapshot: object, options?: object): object, execute(snapshot: object, plan: object): Promise<object>}}
 * Adapter that records a synthetic but contract-valid local PR projection.
 */
export function createLocalPrProjectionAdapter() {
  return {
    adapter: LOCAL_PR_PROJECTION_ADAPTER,
    mode: LOCAL_PR_PROJECTION_MODE,
    externalSideEffects: false,
    plan(snapshot, options = {}) {
      return buildPrProjectionPlan(snapshot, {
        ...options,
        adapter: LOCAL_PR_PROJECTION_ADAPTER,
        mode: LOCAL_PR_PROJECTION_MODE,
        externalSideEffects: false,
      });
    },
    async execute(snapshot, plan) {
      return buildPrProjectionResult(snapshot, plan, {
        status: "projected_local",
        githubPr: buildLocalGithubPr(snapshot, plan),
        externalSideEffects: false,
      });
    },
  };
}

/**
 * Convenience helper that plans and executes the local fake PR projection in one call.
 *
 * @param {object} snapshot Current run snapshot.
 * @param {object} [options] Planning options forwarded to the local adapter.
 * @returns {object} Contract-valid local projection result.
 */
export function buildLocalPrProjection(snapshot, options = {}) {
  const adapter = createLocalPrProjectionAdapter();
  const plan = adapter.plan(snapshot, options);
  return buildPrProjectionResult(snapshot, plan, {
    status: "projected_local",
    githubPr: buildLocalGithubPr(snapshot, plan),
    externalSideEffects: false,
  });
}
