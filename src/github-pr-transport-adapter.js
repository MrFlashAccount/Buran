import {
  buildPrProjectionPlan,
  buildPrProjectionResult,
  projectionContractError,
} from "./pr-projection-adapter.js";
import { sanitizeProjectionDurableValue } from "./projection-contract.js";
import { isRecord, nonEmptyString } from "./utils.js";

export const GITHUB_PR_TRANSPORT_MODE = "github_transport";
export const GITHUB_PR_TRANSPORT_ADAPTER = "github-pr-transport-adapter";
const SUCCESSFUL_TRANSPORT_STATUSES = new Set(["projected", "created", "updated"]);

function publicInvalidTransportStatus(status) {
  const normalized = nonEmptyString(status);
  if (!normalized) return "<empty>";
  return nonEmptyString(sanitizeProjectionDurableValue(normalized)) || "[REDACTED_INVALID_STATUS]";
}

function normalizeTransportProjectionResult(raw, plan) {
  const response = isRecord(raw) ? raw : {};
  const nestedGithubPr = isRecord(response.github_pr) ? response.github_pr : {};
  const number = response.number ?? nestedGithubPr.number;
  const url = nonEmptyString(response.url || nestedGithubPr.url);
  const state = nonEmptyString(response.state || nestedGithubPr.state || "open");
  const title = nonEmptyString(response.title || nestedGithubPr.title || plan.title);
  const status = nonEmptyString(response.status || "");
  const draftValue = response.draft ?? nestedGithubPr.draft;
  const actor = nonEmptyString(response.actor || nestedGithubPr.actor || plan.actor);

  if (!SUCCESSFUL_TRANSPORT_STATUSES.has(status)) {
    throw projectionContractError(
      "projection_invalid_transport_status",
      `GitHub PR transport adapter must return one of ${Array.from(SUCCESSFUL_TRANSPORT_STATUSES).join(", ")}; got ${publicInvalidTransportStatus(status)}.`,
    );
  }
  if (!Number.isSafeInteger(number) || number < 1) {
    throw projectionContractError("projection_invalid_transport_result", "GitHub PR transport adapter must return a positive PR number.");
  }
  if (!url) {
    throw projectionContractError("projection_invalid_transport_result", "GitHub PR transport adapter must return a PR URL.");
  }
  if (typeof draftValue !== "boolean") {
    throw projectionContractError("projection_invalid_transport_result", "GitHub PR transport adapter must return draft as a boolean.");
  }

  return {
    status,
    actor,
    githubPr: {
      number,
      url,
      repo: plan.repo,
      issue_number: plan.issueNumber,
      head_branch: plan.headBranch,
      base_branch: plan.baseBranch,
      state,
      draft: draftValue,
      title,
      projection_mode: plan.mode,
      projected_at: plan.recordedAt,
      actor,
    },
  };
}

export function createGithubPrTransportAdapter({
  projectPr,
  adapter = GITHUB_PR_TRANSPORT_ADAPTER,
  mode = GITHUB_PR_TRANSPORT_MODE,
  externalSideEffects = true,
} = {}) {
  if (typeof projectPr !== "function") {
    throw new Error("createGithubPrTransportAdapter requires projectPr(snapshotContext) => result");
  }

  return {
    adapter,
    mode,
    externalSideEffects: Boolean(externalSideEffects),
    plan(snapshot, options = {}) {
      return buildPrProjectionPlan(snapshot, {
        ...options,
        adapter,
        mode,
        externalSideEffects,
      });
    },
    async execute(snapshot, plan) {
      const transportResult = await projectPr({
        run_id: snapshot?.run_id || "",
        task_id: snapshot?.task_id || "",
        repo: plan.repo,
        issue_number: plan.issueNumber,
        head_branch: plan.headBranch,
        base_branch: plan.baseBranch,
        title: plan.title,
        execution_epoch: plan.executionEpoch,
        intent_idempotency_key: plan.intentIdempotencyKey,
        result_idempotency_key: plan.resultIdempotencyKey,
        verification_gate: plan.verificationGate,
        internal_review_gate: plan.internalReviewGate,
        existing_github_pr: snapshot?.github?.pr || null,
      });
      const normalized = normalizeTransportProjectionResult(transportResult, plan);
      return buildPrProjectionResult(snapshot, plan, {
        status: normalized.status,
        githubPr: normalized.githubPr,
        actor: normalized.actor,
        externalSideEffects,
      });
    },
  };
}
