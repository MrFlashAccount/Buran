/**
 * Transport-backed PR projection adapter that wraps a real GitHub projection implementation.
 *
 * Responsibility:
 * - reuse the local projection contract for intent/result metadata,
 * - normalize transport output into the durable `github.pr` shape,
 * - reject incomplete or status-invalid transport responses before recording.
 *
 * Non-goals:
 * - no validation bypass around the core projection contract,
 * - no assumption that transport output is already sanitized or complete.
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";

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
const execFileAsync = promisify(execFile);

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

/**
 * Creates a projection adapter that delegates PR creation/update to a caller-supplied transport.
 *
 * @param {object} options
 * @param {(snapshotContext: object) => Promise<object>|object} options.projectPr Transport hook that creates or updates the PR.
 * @param {string} [options.adapter=GITHUB_PR_TRANSPORT_ADAPTER] Adapter identifier recorded in durable artifacts.
 * @param {string} [options.mode=GITHUB_PR_TRANSPORT_MODE] Projection mode label recorded in durable artifacts.
 * @param {boolean} [options.externalSideEffects=true] Whether transport execution performs remote writes.
 * @returns {{adapter: string, mode: string, externalSideEffects: boolean, plan(snapshot: object, options?: object): object, execute(snapshot: object, plan: object): Promise<object>}}
 * Adapter that preserves the local projection contract while delegating transport I/O.
 * @throws {Error} When `projectPr` is not a function.
 */
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

function normalizeAllowedRepos(allowedRepos = []) {
  return new Set((Array.isArray(allowedRepos) ? allowedRepos : []).map(nonEmptyString).filter(Boolean));
}

function githubTransportError(code, message) {
  return projectionContractError(code, message);
}

function safeBodyField(value, fallback = "<unknown>") {
  return nonEmptyString(sanitizeProjectionDurableValue(value)) || fallback;
}

function buildDefaultPrBody(context) {
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

async function runGhJson({ execFileImpl, ghPath, args, env }) {
  const { stdout } = await execFileImpl(ghPath, args, { env });
  const text = String(stdout || "").trim();
  if (!text) return null;
  return JSON.parse(text);
}

async function findExistingPullRequest({ execFileImpl, ghPath, env, repo, headBranch, baseBranch }) {
  const rows = await runGhJson({
    execFileImpl,
    ghPath,
    env,
    args: ["pr", "list", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--state", "open", "--json", "number,url,isDraft,title,headRefName,baseRefName,state", "--limit", "1"],
  });
  if (!Array.isArray(rows)) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response was not an array of open stacked PRs.");
  }
  return rows.length > 0 ? rows[0] : null;
}

async function createPullRequest({ execFileImpl, ghPath, env, repo, headBranch, baseBranch, title, body, draft }) {
  const args = ["pr", "create", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  const { stdout } = await execFileImpl(ghPath, args, { env });
  const prSelector = nonEmptyString(stdout) || headBranch;
  return runGhJson({
    execFileImpl,
    ghPath,
    env,
    args: ["pr", "view", prSelector, "--repo", repo, "--json", "number,url,isDraft,title,headRefName,baseRefName,state"],
  });
}

async function updatePullRequest({ execFileImpl, ghPath, env, repo, number, baseBranch, title, body }) {
  await execFileImpl(ghPath, ["pr", "edit", String(number), "--repo", repo, "--base", baseBranch, "--title", title, "--body", body], { env });
  return runGhJson({
    execFileImpl,
    ghPath,
    env,
    args: ["pr", "view", String(number), "--repo", repo, "--json", "number,url,isDraft,title,headRefName,baseRefName,state"],
  });
}

/**
 * Builds a real GitHub CLI-backed projection hook for createGithubPrTransportAdapter.
 *
 * The hook is disabled by default, requires an explicit repo allowlist, and receives
 * the already-recorded local projection intent before it performs any remote write.
 */
export function createGithubCliProjectPr({
  enabled = false,
  allowedRepos = [],
  draft = true,
  ghPath = "gh",
  execFileImpl = execFileAsync,
  env = process.env,
  bodyBuilder = buildDefaultPrBody,
} = {}) {
  const repoAllowlist = normalizeAllowedRepos(allowedRepos);
  return async function projectPr(context = {}) {
    const repo = nonEmptyString(context.repo);
    const headBranch = nonEmptyString(context.head_branch);
    const baseBranch = nonEmptyString(context.base_branch);
    if (!enabled) {
      throw githubTransportError("projection_github_transport_disabled", "GitHub PR transport is disabled until explicitly configured.");
    }
    if (!repo || !repoAllowlist.has(repo)) {
      throw githubTransportError("projection_github_repo_not_allowed", "GitHub PR transport requires the target repo to be explicitly allowlisted.");
    }
    if (!headBranch || !baseBranch) {
      throw githubTransportError("projection_github_stack_incomplete", "GitHub PR transport requires explicit stacked head and base branches.");
    }

    const rawTitle = nonEmptyString(context.title) || `Buran handoff for ${context.task_id || context.run_id || "run"}`;
    const title = safeBodyField(rawTitle, "Buran handoff for run");
    const rawBody = nonEmptyString(bodyBuilder(context)) || buildDefaultPrBody(context);
    const body = safeBodyField(rawBody, buildDefaultPrBody({}));
    const existing = await findExistingPullRequest({ execFileImpl, ghPath, env, repo, headBranch, baseBranch });
    if (existing) {
      assertRemotePrMatchesStack(existing, { headBranch, baseBranch });
      if (!Number.isSafeInteger(existing.number) || existing.number < 1) {
        throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response did not include a valid existing PR number.");
      }
    }
    const raw = existing
      ? await updatePullRequest({ execFileImpl, ghPath, env, repo, number: existing.number, baseBranch, title, body })
      : await createPullRequest({ execFileImpl, ghPath, env, repo, headBranch, baseBranch, title, body, draft });
    assertRemotePrMatchesStack(raw, { headBranch, baseBranch });

    return {
      status: existing ? "updated" : "created",
      number: raw?.number,
      url: raw?.url,
      draft: Boolean(raw?.isDraft),
      title: safeBodyField(raw?.title || title, title),
      state: nonEmptyString(raw?.state).toLowerCase() || "open",
      actor: GITHUB_PR_TRANSPORT_ADAPTER,
    };
  };
}

export function createGithubCliPrProjectionAdapter(options = {}) {
  return createGithubPrTransportAdapter({
    projectPr: createGithubCliProjectPr(options),
    adapter: options.adapter || GITHUB_PR_TRANSPORT_ADAPTER,
    mode: options.mode || GITHUB_PR_TRANSPORT_MODE,
    externalSideEffects: Boolean(options.enabled),
  });
}
