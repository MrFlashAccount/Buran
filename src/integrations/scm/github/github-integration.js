import { projectionContractError } from "../../../core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js";
import { sanitizeProjectionDurableValue } from "../../../core/modules/scm-handoff/contract.js";
import { isRecord, nonEmptyString } from "../../../shared/primitives.js";
import { createIntegrationDescriptor } from "../../integration.js";
import { createGitHubCliClient, GitHubCliClient } from "./github-cli-client.js";
import { normalizeAllowedRepos } from "./config.js";

/** Descriptor exposed for composition/debug surfaces that need to see the GitHub PR transport boundary. */
export const GITHUB_PR_INTEGRATION_DESCRIPTOR = createIntegrationDescriptor({
  name: "github-pr-transport",
  kind: "scm",
  boundary: "Projects an approved local SCM handoff into GitHub pull requests through the noninteractive gh CLI client.",
  implementsPorts: ["projectPullRequest(context) transport used by GitHubScmHandoffAdapter"],
  externalSideEffects: true,
});

function githubTransportError(code, message) {
  return projectionContractError(code, message);
}

function artifactRefsPresent(refs) {
  return Array.isArray(refs) && refs.length > 0 && refs.every((ref) => nonEmptyString(ref?.path) && nonEmptyString(ref?.sha256));
}

function gatePassedForEpoch(gate, executionEpoch) {
  return isRecord(gate)
    && gate.status === "PASS"
    && gate.current_epoch === executionEpoch
    && Number.isSafeInteger(gate.current_attempt)
    && gate.current_attempt >= 1
    && artifactRefsPresent(gate.artifact_refs);
}

/**
 * Assert that a PR projection context carries current local workflow evidence.
 *
 * @param {object} context Transport context built from an SCM handoff plan and run snapshot.
 * @throws {Error & {code: string}} When epoch, idempotency keys, or PASS gates are missing/stale.
 */
export function assertMasterWorkflowContext(context) {
  const executionEpoch = context.execution_epoch;
  if (!Number.isSafeInteger(executionEpoch) || executionEpoch < 1) {
    throw githubTransportError("projection_github_workflow_context_missing", "GitHub PR transport requires a current local execution epoch from the recorded local master workflow.");
  }
  if (!nonEmptyString(context.intent_idempotency_key) || !nonEmptyString(context.result_idempotency_key)) {
    throw githubTransportError("projection_github_workflow_context_missing", "GitHub PR transport requires recorded projection idempotency keys before any remote write.");
  }
  if (!gatePassedForEpoch(context.verification_gate, executionEpoch) || !gatePassedForEpoch(context.internal_review_gate, executionEpoch)) {
    throw githubTransportError("projection_github_workflow_gates_not_passed", "GitHub PR transport requires current-epoch verification PASS and internal-review PASS from the local master workflow.");
  }
}

function safeBodyField(value, fallback = "<unknown>") {
  return nonEmptyString(sanitizeProjectionDurableValue(value)) || fallback;
}

/**
 * Build the default GitHub PR body from sanitized local run/stack metadata.
 *
 * @param {object} context Transport context containing run id, task id, and stack branches.
 * @returns {string} Markdown PR body that points reviewers back to the local registry source of truth.
 */
export function buildDefaultPrBody(context) {
  return [
    "## Buran stacked PR handoff",
    "",
    `Run: ${safeBodyField(context.run_id)}`,
    `Task: ${safeBodyField(context.task_id)}`,
    `Base: ${safeBodyField(context.base_branch)}`,
    `Head: ${safeBodyField(context.head_branch)}`,
    "",
    "Local registry remains the source of truth for verification/review artifacts.",
  ].join("\n");
}

function assertRemotePrMatchesStack(raw, { headBranch, baseBranch }) {
  const remoteHead = nonEmptyString(raw?.headRefName);
  const remoteBase = nonEmptyString(raw?.baseRefName);
  const remoteState = nonEmptyString(raw?.state);
  if (remoteHead !== headBranch || remoteBase !== baseBranch) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport response did not match the explicit stacked head/base branches.");
  }
  if (remoteState !== "OPEN" && remoteState !== "open") {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport response was not an open PR.");
  }
}

function assertRemotePrComplete(raw) {
  if (!Number.isSafeInteger(raw?.number) || raw.number < 1) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport view response did not include a valid PR number.");
  }
  if (!nonEmptyString(raw?.url)) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport view response did not include a PR URL.");
  }
  if (typeof raw?.isDraft !== "boolean") {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport view response did not include isDraft as a boolean.");
  }
  if (!nonEmptyString(raw?.title)) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport view response did not include a PR title.");
  }
}

/**
 * GitHub PR transport integration used behind the provider-neutral SCM handoff adapter.
 *
 * Responsibility:
 * - validate local master-workflow evidence before remote writes;
 * - list an existing open stacked PR by explicit head/base branch;
 * - create or update exactly one GitHub PR; and
 * - return a compact provider-neutral transport result.
 *
 * Side effects: when `enabled` is true and `projectPullRequest` passes validation, this class may execute
 * `gh pr list`, `gh pr create`, `gh pr edit`, and `gh pr view` through the injected client. It does not write
 * the local registry directly.
 *
 * Context shape: `projectPullRequest(context)` expects run/task ids, `repo`, `head_branch`, `base_branch`,
 * optional `title`, current `execution_epoch`, projection idempotency keys, and current-epoch PASS gate summaries.
 * Result shape: `{status, number, url, draft, title, state, actor}` where status is `created` or `updated`.
 *
 * Constructor dependencies: allowlist/config flags, a `GitHubCliClient`-compatible client,
 * optional PR body builder, and actor label for durable projection reports.
 */
export class GitHubIntegration {
  constructor({ enabled = false, allowedRepos = [], draft = true, client = null, bodyBuilder = buildDefaultPrBody, actor = "github-pr-transport-adapter" } = {}) {
    this.enabled = Boolean(enabled);
    this.allowedRepos = normalizeAllowedRepos(allowedRepos);
    this.draft = Boolean(draft);
    this.client = client || createGitHubCliClient();
    this.bodyBuilder = bodyBuilder;
    this.actor = actor;
    this.integrationDescriptor = GITHUB_PR_INTEGRATION_DESCRIPTOR;
  }

  async projectPullRequest(context = {}) {
    const repo = nonEmptyString(context.repo);
    const headBranch = nonEmptyString(context.head_branch);
    const baseBranch = nonEmptyString(context.base_branch);
    if (!this.enabled) {
      throw githubTransportError("projection_github_transport_disabled", "GitHub PR transport is disabled until explicitly configured.");
    }
    if (!repo || !this.allowedRepos.has(repo)) {
      throw githubTransportError("projection_github_repo_not_allowed", "GitHub PR transport requires the target repo to be explicitly allowlisted.");
    }
    if (!headBranch || !baseBranch) {
      throw githubTransportError("projection_github_stack_incomplete", "GitHub PR transport requires explicit stacked head and base branches.");
    }
    assertMasterWorkflowContext(context);

    const rawTitle = nonEmptyString(context.title) || `Buran handoff for ${context.task_id || context.run_id || "run"}`;
    const title = safeBodyField(rawTitle, "Buran handoff for run");
    const rawBody = nonEmptyString(this.bodyBuilder(context)) || buildDefaultPrBody(context);
    const body = safeBodyField(rawBody, buildDefaultPrBody({}));
    const rows = await this.client.listPullRequests({ repo, headBranch, baseBranch });
    if (!Array.isArray(rows)) {
      throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response was not an array of open stacked PRs.");
    }
    if (rows.length > 1) {
      throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport found multiple open PRs for the explicit stacked head/base branches.");
    }
    const existing = rows.length > 0 ? rows[0] : null;
    if (existing) {
      assertRemotePrMatchesStack(existing, { headBranch, baseBranch });
      if (!Number.isSafeInteger(existing.number) || existing.number < 1) {
        throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response did not include a valid existing PR number.");
      }
    }

    const raw = existing
      ? await this.client.updatePullRequest({ repo, number: existing.number, baseBranch, title, body })
      : await this.client.createPullRequest({ repo, headBranch, baseBranch, title, body, draft: this.draft });
    assertRemotePrMatchesStack(raw, { headBranch, baseBranch });
    assertRemotePrComplete(raw);

    return {
      status: existing ? "updated" : "created",
      number: raw?.number,
      url: raw?.url,
      draft: raw.isDraft,
      title: safeBodyField(raw?.title || title, title),
      state: nonEmptyString(raw?.state).toLowerCase() || "open",
      actor: this.actor,
    };
  }
}

/**
 * Create a function adapter that projects a PR through `GitHubIntegration` backed by `GitHubCliClient`.
 *
 * @param {object} [options] GitHub integration options plus CLI client options.
 * @returns {(context?: object) => Promise<object>} `projectPullRequest`-compatible transport function.
 */
export function createGithubCliProjectPr(options = {}) {
  const { ghPath, execFileImpl, env, extraEnv, timeoutMs, ...integrationOptions } = options;
  const client = options.client instanceof GitHubCliClient ? options.client : createGitHubCliClient({ ghPath, execFileImpl, env, extraEnv, timeoutMs });
  const integration = new GitHubIntegration({ ...integrationOptions, client });
  return (context = {}) => integration.projectPullRequest(context);
}
