import { buildScmHandoffPlan, buildScmHandoffResult, projectionContractError } from "../../../core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js";
import { sanitizeProjectionDurableValue } from "../../../core/modules/scm-handoff/contract.js";
import { assertScmHandoffPort } from "../../../core/modules/scm-handoff/ports/scm-handoff-port.js";
import { isRecord, nonEmptyString } from "../../../shared/primitives.js";
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./config.js";
import { GitHubIntegration, assertMasterWorkflowContext, createGithubCliProjectPr } from "./github-integration.js";
import { createGitHubCliClient } from "./github-cli-client.js";

/** Projection mode recorded for GitHub-backed PR handoff transport results. */
export const GITHUB_PR_TRANSPORT_MODE = "github_transport";
/** Alias retained for provider-neutral SCM handoff call sites that still consume the GitHub mode. */
export const GITHUB_SCM_HANDOFF_MODE = GITHUB_PR_TRANSPORT_MODE;
/** Public adapter id for the GitHub PR transport profile. */
export const GITHUB_PR_TRANSPORT_ADAPTER = "github-pr-transport-adapter";
/** Public adapter id for the GitHub SCM handoff implementation. */
export const GITHUB_SCM_HANDOFF_ADAPTER = "github-scm-handoff-adapter";
const SUCCESSFUL_TRANSPORT_STATUSES = new Set(["projected", "created", "updated"]);

function publicInvalidTransportStatus(status) {
  const normalized = nonEmptyString(status);
  if (!normalized) return "<empty>";
  return nonEmptyString(sanitizeProjectionDurableValue(normalized)) || "[REDACTED_INVALID_STATUS]";
}

function validateTransportPrUrl(url, { repo, number, githubHost }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw projectionContractError("projection_invalid_transport_result", "GitHub PR transport adapter must return a valid PR URL.");
  }
  const expectedHost = normalizeGithubHost(githubHost);
  const pathParts = parsed.pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const repoParts = nonEmptyString(repo).split("/").filter(Boolean);
  const expectedNumber = String(number);
  const matches = parsed.protocol === "https:"
    && parsed.host.toLowerCase() === expectedHost
    && !parsed.search
    && !parsed.hash
    && repoParts.length === 2
    && pathParts.length === 4
    && pathParts[0] === repoParts[0]
    && pathParts[1] === repoParts[1]
    && pathParts[2] === "pull"
    && pathParts[3] === expectedNumber;
  if (!matches) {
    throw projectionContractError("projection_invalid_transport_result", "GitHub PR transport adapter returned a PR URL outside the configured host/repo/number binding.");
  }
}

function normalizeTransportProjectionResult(raw, plan, { githubHost = DEFAULT_GITHUB_HOST } = {}) {
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
  validateTransportPrUrl(url, { repo: plan.repo, number, githubHost });

  return {
    status,
    actor,
    handoffTarget: {
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

/**
 * GitHub-backed implementation of the provider-neutral SCM handoff port.
 *
 * Constructor dependencies:
 * - `integration`: object exposing `projectPullRequest(context)`; or
 * - `projectPr`: function used as `projectPullRequest` for tests/lightweight callers.
 *
 * Invariants:
 * - `plan(snapshot, options)` records local handoff intent metadata before any remote write.
 * - `execute(snapshot, plan)` validates master-workflow evidence when external side effects are enabled.
 * - transport results must bind to the configured GitHub host, repo, PR number, and draft/title shape before
 *   they are converted into a durable provider-neutral handoff result.
 */
export class GitHubScmHandoffAdapter {
  constructor({ integration, projectPr, adapter = GITHUB_PR_TRANSPORT_ADAPTER, mode = GITHUB_PR_TRANSPORT_MODE, externalSideEffects = true, githubHost = DEFAULT_GITHUB_HOST } = {}) {
    if (integration && typeof integration.projectPullRequest !== "function") {
      throw new Error("GitHubScmHandoffAdapter requires integration.projectPullRequest(context) => result");
    }
    if (!integration && typeof projectPr !== "function") {
      throw new Error("GitHubScmHandoffAdapter requires GitHubIntegration or projectPr(context) => result");
    }
    this.integration = integration || { projectPullRequest: projectPr };
    this.adapter = adapter;
    this.mode = mode;
    this.externalSideEffects = Boolean(externalSideEffects);
    this.githubHost = githubHost;
  }

  /**
   * Build an SCM handoff plan for a run snapshot.
   *
   * @param {object} snapshot Execution-run snapshot containing SCM target and gate evidence.
   * @param {object} [options] Planner overrides such as actor/clock/idempotency metadata.
   * @returns {object} Provider-neutral handoff plan consumed by `execute` and local journaling.
   */
  plan(snapshot, options = {}) {
    return buildScmHandoffPlan(snapshot, {
      ...options,
      adapter: this.adapter,
      mode: this.mode,
      externalSideEffects: this.externalSideEffects,
    });
  }

  /**
   * Execute the approved handoff plan through the configured GitHub integration.
   *
   * @param {object} snapshot Execution-run snapshot used for run identity and existing PR context.
   * @param {object} plan Plan produced by `plan(snapshot, options)`.
   * @returns {Promise<object>} Provider-neutral handoff result suitable for projection-ledger recording.
   */
  async execute(snapshot, plan) {
    const transportContext = {
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
    };
    if (this.externalSideEffects) assertMasterWorkflowContext(transportContext);
    const transportResult = await this.integration.projectPullRequest(transportContext);
    const normalized = normalizeTransportProjectionResult(transportResult, plan, { githubHost: this.githubHost });
    return buildScmHandoffResult(snapshot, plan, {
      status: normalized.status,
      handoffTarget: normalized.handoffTarget,
      actor: normalized.actor,
      externalSideEffects: this.externalSideEffects,
    });
  }
}

/**
 * Create a GitHub SCM handoff adapter and assert it satisfies the handoff port.
 *
 * @param {object} [options] `GitHubScmHandoffAdapter` constructor options.
 * @returns {GitHubScmHandoffAdapter} Port-checked adapter instance.
 */
export function createGithubPrTransportAdapter(options = {}) {
  return assertScmHandoffPort(new GitHubScmHandoffAdapter(options));
}

/**
 * Create a GitHub CLI-backed handoff adapter for local composition.
 *
 * @param {object} [options] CLI client, environment, host, mode, adapter id, and enablement options.
 * @returns {GitHubScmHandoffAdapter} Port-checked GitHub CLI adapter; external writes occur only when enabled.
 */
export function createGithubCliPrProjectionAdapter(options = {}) {
  const actor = options.adapter || GITHUB_PR_TRANSPORT_ADAPTER;
  const client = options.client || createGitHubCliClient(options);
  const integration = new GitHubIntegration({ ...options, client, actor });
  return createGithubPrTransportAdapter({
    integration,
    adapter: actor,
    mode: options.mode || GITHUB_PR_TRANSPORT_MODE,
    externalSideEffects: Boolean(options.enabled),
    githubHost: options.githubHost || options.env?.GH_HOST || DEFAULT_GITHUB_HOST,
  });
}

export { createGithubCliProjectPr, GitHubIntegration };
