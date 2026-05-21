import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { projectionContractError } from "../../../core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js";
import { nonEmptyString } from "../../../shared/primitives.js";
import { buildGithubCliEnv, DEFAULT_GH_TIMEOUT_MS } from "./config.js";

const execFileAsync = promisify(execFile);

function githubTransportError(code, message) {
  return projectionContractError(code, message);
}

function isGithubCliTimeout(error) {
  return Boolean(error?.timedOut || error?.timeout || error?.code === "ETIMEDOUT" || (error?.killed && nonEmptyString(error?.signal)));
}

function isGithubCliAuthFailure(error) {
  const text = `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`.toLowerCase();
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

/**
 * Noninteractive GitHub CLI client for the GitHub PR transport integration.
 *
 * Contract:
 * - invokes `gh` with explicit argv arrays via injected `execFileImpl`;
 * - never prompts interactively; auth must already be available from the supplied environment;
 * - merges `env` and `extraEnv` through `buildGithubCliEnv`;
 * - applies a positive `timeoutMs`, defaulting to `DEFAULT_GH_TIMEOUT_MS`; and
 * - normalizes process failures into projection errors with stable `code` values.
 *
 * Methods:
 * - `run(args)` executes raw `gh` commands and returns stdout/stderr from `execFile`;
 * - `runJson(args)` parses JSON stdout or returns `null` for empty output;
 * - PR helpers map to `gh pr list/create/edit/view` with explicit repo/head/base selectors.
 *
 * Error semantics: missing CLI => `projection_github_unavailable`; timeout => `projection_github_timeout`;
 * auth/permission/interactive-login failure => `projection_github_auth_failed`; malformed JSON or PR shape mismatch
 * is reported as `projection_github_remote_mismatch` by this client or its caller.
 */
export class GitHubCliClient {
  constructor({ ghPath = "gh", execFileImpl = execFileAsync, env = process.env, extraEnv = {}, timeoutMs = DEFAULT_GH_TIMEOUT_MS } = {}) {
    this.ghPath = ghPath;
    this.execFileImpl = execFileImpl;
    this.env = buildGithubCliEnv(env, extraEnv);
    this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_GH_TIMEOUT_MS;
  }

  async run(args) {
    try {
      return await this.execFileImpl(this.ghPath, args, { env: this.env, timeout: this.timeoutMs, windowsHide: true });
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

  async runJson(args) {
    const { stdout } = await this.run(args);
    const text = String(stdout || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw githubTransportError("projection_github_remote_mismatch", "GitHub PR transport response was not valid JSON.");
    }
  }

  listPullRequests({ repo, headBranch, baseBranch }) {
    return this.runJson(["pr", "list", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--state", "open", "--json", "number,url,isDraft,title,headRefName,baseRefName,state", "--limit", "2"]);
  }

  async createPullRequest({ repo, headBranch, baseBranch, title, body, draft }) {
    const args = ["pr", "create", "--repo", repo, "--head", headBranch, "--base", baseBranch, "--title", title, "--body", body];
    if (draft) args.push("--draft");
    const { stdout } = await this.run(args);
    const prSelector = nonEmptyString(stdout) || headBranch;
    return this.viewPullRequest({ repo, selector: prSelector });
  }

  async updatePullRequest({ repo, number, baseBranch, title, body }) {
    await this.run(["pr", "edit", String(number), "--repo", repo, "--base", baseBranch, "--title", title, "--body", body]);
    return this.viewPullRequest({ repo, selector: String(number) });
  }

  viewPullRequest({ repo, selector }) {
    return this.runJson(["pr", "view", String(selector), "--repo", repo, "--json", "number,url,isDraft,title,headRefName,baseRefName,state"]);
  }
}

/**
 * Create a `gh` CLI client for GitHub PR transport calls.
 *
 * @param {object} [options] CLI path, exec implementation, environment, additional env, and timeout settings.
 * @returns {GitHubCliClient} Noninteractive GitHub CLI client.
 */
export function createGitHubCliClient(options = {}) {
  return new GitHubCliClient(options);
}
