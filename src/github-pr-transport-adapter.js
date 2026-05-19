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
const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_GH_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

function publicInvalidTransportStatus(status) {
  const normalized = nonEmptyString(status);
  if (!normalized) return "<empty>";
  return nonEmptyString(sanitizeProjectionDurableValue(normalized)) || "[REDACTED_INVALID_STATUS]";
}

function normalizeGithubHost(host) {
  const rawHost = nonEmptyString(host) || DEFAULT_GITHUB_HOST;
  try {
    return new URL(rawHost.includes("://") ? rawHost : `https://${rawHost}`).host.toLowerCase();
  } catch {
    return rawHost.toLowerCase();
  }
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
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
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
  githubHost = DEFAULT_GITHUB_HOST,
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
      if (externalSideEffects) assertMasterWorkflowContext(transportContext);
      const transportResult = await projectPr(transportContext);
      const normalized = normalizeTransportProjectionResult(transportResult, plan, { githubHost });
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

function artifactRefsPresent(refs) {
  return Array.isArray(refs)
    && refs.length > 0
    && refs.every((ref) => nonEmptyString(ref?.path) && nonEmptyString(ref?.sha256));
}

function gatePassedForEpoch(gate, executionEpoch) {
  return isRecord(gate)
    && gate.status === "PASS"
    && gate.current_epoch === executionEpoch
    && Number.isSafeInteger(gate.current_attempt)
    && gate.current_attempt >= 1
    && artifactRefsPresent(gate.artifact_refs);
}

function assertMasterWorkflowContext(context) {
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

function buildGithubCliEnv(sourceEnv = {}, extraEnv = {}) {
  const allowedKeys = [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "NO_COLOR",
    "CI",
  ];
  const result = {};
  const source = isRecord(sourceEnv) ? sourceEnv : {};
  for (const key of allowedKeys) {
    const value = nonEmptyString(source[key]);
    if (value) result[key] = value;
  }
  result.GH_PROMPT_DISABLED = "1";
  result.GIT_TERMINAL_PROMPT = "0";
  const optIn = isRecord(extraEnv) ? extraEnv : {};
  for (const [key, value] of Object.entries(optIn)) {
    const normalizedKey = nonEmptyString(key);
    const normalizedValue = nonEmptyString(value);
    if (normalizedKey && normalizedValue) result[normalizedKey] = normalizedValue;
  }
  return result;
}

function isGithubCliTimeout(error) {
  return Boolean(error?.timedOut || error?.timeout || error?.code === "ETIMEDOUT" || (error?.killed && nonEmptyString(error?.signal)));
}

function isGithubCliAuthFailure(error) {
  const text = `${error?.stderr || ""}
${error?.stdout || ""}
${error?.message || ""}`.toLowerCase();
  return /auth|credential|login|token|gh auth|permission denied|could not prompt/.test(text);
}

function classifyGithubCliError(error) {
  if (isGithubCliTimeout(error)) return "projection_github_timeout";
  if (error?.code === "ENOENT") return "projection_github_unavailable";
  if (isGithubCliAuthFailure(error)) return "projection_github_auth_failed";
  return "projection_github_unavailable";
}

function publicGhAction(args) {
  return [args?.[0], args?.[1]].map(nonEmptyString).filter(Boolean).join(" ") || "gh";
}

async function runGh({ execFileImpl, ghPath, args, env, timeoutMs }) {
  try {
    return await execFileImpl(ghPath, args, { env, timeout: timeoutMs, windowsHide: true });
  } catch (error) {
    const code = classifyGithubCliError(error);
    const action = publicGhAction(args);
    const message = code === "projection_github_timeout"
      ? `GitHub CLI command ${action} timed out before returning noninteractive PR transport data.`
      : code === "projection_github_auth_failed"
      ? `GitHub CLI command ${action} failed authentication or required interactive auth.`
      : `GitHub CLI command ${action} was unavailable or failed before returning PR transport data.`;
    throw githubTransportError(code, message);
  }
}

async function runGhJson({ execFileImpl, ghPath, args, env, timeoutMs }) {
  const { stdout } = await runGh({ execFileImpl, ghPath, args, env, timeoutMs });
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport response was not valid JSON.");
  }
}

async function findExistingPullRequest({ execFileImpl, ghPath, env, timeoutMs, repo, headBranch, baseBranch }) {
  const rows = await runGhJson({
    execFileImpl,
    ghPath,
    env,
    timeoutMs,
    args: ["pr", "list", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--state", "open", "--json", "number,url,isDraft,title,headRefName,baseRefName,state", "--limit", "2"],
  });
  if (!Array.isArray(rows)) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response was not an array of open stacked PRs.");
  }
  if (rows.length > 1) {
    throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport found multiple open PRs for the explicit stacked head/base branches.");
  }
  return rows.length > 0 ? rows[0] : null;
}

async function createPullRequest({ execFileImpl, ghPath, env, timeoutMs, repo, headBranch, baseBranch, title, body, draft }) {
  const args = ["pr", "create", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  const { stdout } = await runGh({ execFileImpl, ghPath, args, env, timeoutMs });
  const prSelector = nonEmptyString(stdout) || headBranch;
  return runGhJson({
    execFileImpl,
    ghPath,
    env,
    timeoutMs,
    args: ["pr", "view", prSelector, "--repo", repo, "--json", "number,url,isDraft,title,headRefName,baseRefName,state"],
  });
}

async function updatePullRequest({ execFileImpl, ghPath, env, timeoutMs, repo, number, baseBranch, title, body }) {
  await runGh({ execFileImpl, ghPath, args: ["pr", "edit", String(number), "--repo", repo, "--base", baseBranch, "--title", title, "--body", body], env, timeoutMs });
  return runGhJson({
    execFileImpl,
    ghPath,
    env,
    timeoutMs,
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
  extraEnv = {},
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
  bodyBuilder = buildDefaultPrBody,
} = {}) {
  const repoAllowlist = normalizeAllowedRepos(allowedRepos);
  const ghEnv = buildGithubCliEnv(env, extraEnv);
  const ghTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_GH_TIMEOUT_MS;
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
    assertMasterWorkflowContext(context);

    const rawTitle = nonEmptyString(context.title) || `Buran handoff for ${context.task_id || context.run_id || "run"}`;
    const title = safeBodyField(rawTitle, "Buran handoff for run");
    const rawBody = nonEmptyString(bodyBuilder(context)) || buildDefaultPrBody(context);
    const body = safeBodyField(rawBody, buildDefaultPrBody({}));
    const existing = await findExistingPullRequest({ execFileImpl, ghPath, env: ghEnv, timeoutMs: ghTimeoutMs, repo, headBranch, baseBranch });
    if (existing) {
      assertRemotePrMatchesStack(existing, { headBranch, baseBranch });
      if (!Number.isSafeInteger(existing.number) || existing.number < 1) {
        throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport list response did not include a valid existing PR number.");
      }
    }
    const raw = existing
      ? await updatePullRequest({ execFileImpl, ghPath, env: ghEnv, timeoutMs: ghTimeoutMs, repo, number: existing.number, baseBranch, title, body })
      : await createPullRequest({ execFileImpl, ghPath, env: ghEnv, timeoutMs: ghTimeoutMs, repo, headBranch, baseBranch, title, body, draft });
    assertRemotePrMatchesStack(raw, { headBranch, baseBranch });
    assertRemotePrComplete(raw);

    return {
      status: existing ? "updated" : "created",
      number: raw?.number,
      url: raw?.url,
      draft: raw.isDraft,
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
    githubHost: options.githubHost || options.env?.GH_HOST || DEFAULT_GITHUB_HOST,
  });
}
