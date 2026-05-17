import path from "node:path";

import { isRecord, nonEmptyString } from "./utils.js";

export const SUCCESSFUL_PROJECTION_RESULT_STATUSES = new Set(["projected_local", "projected", "created", "updated"]);

const SECRET_VALUE_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\b(?:token|secret|password|authorization|api[_-]?key)=([^\s&]{4,})/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTimestampString(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function safePublicBasename(filePath) {
  const basename = path.posix.basename(String(filePath).replace(/\\/g, "/").replace(/\/+$/g, ""));
  if (!basename || basename === "/" || basename === "." || basename === "..") return "";
  const sanitized = redactSecretsInText(basename);
  if (sanitized.includes("[REDACTED_SECRET]")) return "";
  return sanitized;
}

function redactSecretsInText(value) {
  let redacted = String(value ?? "");
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (/=/.test(match) && !/^Bearer/i.test(match)) return match.replace(/=.*/, "=[REDACTED]");
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      return "[REDACTED_SECRET]";
    });
  }
  return redacted;
}

function redactAbsolutePathMatch(match, prefix = "") {
  const pathText = prefix ? match.slice(prefix.length) : match;
  const basename = safePublicBasename(pathText);
  return `${prefix}<absolute_path>${basename ? `/${basename}` : ""}`;
}

function redactAbsolutePaths(value) {
  let redacted = String(value ?? "");
  redacted = redacted.replace(/(^|[\s"'([{=,:;])((?:\/(?!\/)[^\s"'<>()[\]{}|`]+){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  redacted = redacted.replace(/(^|[\s"'([{=,:;])([A-Za-z]:\\(?:[^\\\s"'<>()[\]{}|`]+\\?){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  redacted = redacted.replace(/\/(?:Users|home)\/[^\s"'<>()[\]{}|`]+(?:\/[^\s"'<>()[\]{}|`]+)*/g, (match) => redactAbsolutePathMatch(match));
  return redacted;
}

function sanitizeProjectionString(value) {
  return redactSecretsInText(redactAbsolutePaths(value));
}

export function sanitizeProjectionDurableValue(value, { depth = 0 } = {}) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeProjectionString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeProjectionDurableValue(entry, { depth: depth + 1 }));
  if (!isRecord(value)) return sanitizeProjectionString(String(value));
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = sanitizeProjectionDurableValue(entry, { depth: depth + 1 });
  return output;
}

export function isSuccessfulProjectionResultStatus(status) {
  return SUCCESSFUL_PROJECTION_RESULT_STATUSES.has(nonEmptyString(status));
}

export function isValidProjectionUrl(value) {
  const text = nonEmptyString(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol === "local:") return parsed.hostname === "github-pr" && /\/pull\/\d+$/.test(parsed.pathname);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return Boolean(parsed.hostname) && /\/pull\/\d+$/.test(parsed.pathname);
    return false;
  } catch {
    return false;
  }
}

export function appendGithubPrValidationErrors(githubPr, errors, fieldPath = "github.pr") {
  if (!isRecord(githubPr)) {
    errors.push(`${fieldPath} must be an object`);
    return;
  }
  if (!Number.isSafeInteger(githubPr.number) || githubPr.number < 1) errors.push(`${fieldPath}.number must be a positive integer`);
  if (!isValidProjectionUrl(githubPr.url)) errors.push(`${fieldPath}.url must be a valid local:// or http(s):// PR URL`);
  if (!nonEmptyString(githubPr.repo)) errors.push(`${fieldPath}.repo must be a non-empty string`);
  if (!hasOwn(githubPr, "issue_number") || !(githubPr.issue_number === null || Number.isSafeInteger(githubPr.issue_number))) {
    errors.push(`${fieldPath}.issue_number must be an integer or null`);
  }
  if (!nonEmptyString(githubPr.head_branch)) errors.push(`${fieldPath}.head_branch must be a non-empty string`);
  if (!nonEmptyString(githubPr.base_branch)) errors.push(`${fieldPath}.base_branch must be a non-empty string`);
  if (!nonEmptyString(githubPr.state)) errors.push(`${fieldPath}.state must be a non-empty string`);
  if (typeof githubPr.draft !== "boolean") errors.push(`${fieldPath}.draft must be a boolean`);
  if (!nonEmptyString(githubPr.title)) errors.push(`${fieldPath}.title must be a non-empty string`);
  if (hasOwn(githubPr, "projection_mode") && typeof githubPr.projection_mode !== "string") errors.push(`${fieldPath}.projection_mode must be a string when present`);
  if (hasOwn(githubPr, "projected_at") && !isTimestampString(githubPr.projected_at)) errors.push(`${fieldPath}.projected_at must be a timestamp string when present`);
  if (hasOwn(githubPr, "actor") && !nonEmptyString(githubPr.actor)) errors.push(`${fieldPath}.actor must be a non-empty string when present`);
}

export function appendGithubPrContractErrors(snapshot, githubPr, errors, fieldPath = "github.pr") {
  const expectedRepo = nonEmptyString(snapshot?.github?.repo);
  const expectedIssueNumber = Number.isSafeInteger(snapshot?.github?.issue_number) ? snapshot.github.issue_number : null;
  const expectedHeadBranch = nonEmptyString(snapshot?.github?.intended_branch);
  const expectedBaseBranch = nonEmptyString(snapshot?.github?.base_branch);

  if (!expectedRepo) errors.push(`${fieldPath}.repo cannot be verified because github.repo is missing from the local contract`);
  else if (githubPr?.repo !== expectedRepo) errors.push(`${fieldPath}.repo must match github.repo`);

  if (expectedIssueNumber === null) errors.push(`${fieldPath}.issue_number cannot be verified because github.issue_number is missing from the local contract`);
  else if (githubPr?.issue_number !== expectedIssueNumber) errors.push(`${fieldPath}.issue_number must match github.issue_number`);

  if (!expectedHeadBranch) errors.push(`${fieldPath}.head_branch cannot be verified because github.intended_branch is missing from the local contract`);
  else if (githubPr?.head_branch !== expectedHeadBranch) errors.push(`${fieldPath}.head_branch must match github.intended_branch`);

  if (!expectedBaseBranch) errors.push(`${fieldPath}.base_branch cannot be derived from the local run contract`);
  else if (githubPr?.base_branch !== expectedBaseBranch) errors.push(`${fieldPath}.base_branch must match github.base_branch`);
}

export function appendProjectedPrParityErrors(left, right, errors, leftPath = "github.pr", rightPath = "projections.github_pr.last_result.github_pr") {
  const comparableKeys = ["number", "url", "repo", "issue_number", "head_branch", "base_branch", "state", "draft", "title"];
  for (const key of comparableKeys) {
    if ((left?.[key] ?? null) !== (right?.[key] ?? null)) errors.push(`${leftPath}.${key} must match ${rightPath}.${key}`);
  }
}

export function mergeProjectionSnapshot(snapshot, payload, sequence) {
  const currentProjection = isRecord(snapshot.projections?.github_pr) ? snapshot.projections.github_pr : {};
  const nextProjection = {
    projection_name: payload.projection_name,
    projection_target: payload.projection_target,
    adapter: payload.adapter,
    mode: payload.mode,
    execution_epoch: payload.execution_epoch,
    recorded_from_state: payload.recorded_from_state,
    ...(isRecord(currentProjection.last_intent) ? { last_intent: currentProjection.last_intent } : {}),
    ...(isRecord(currentProjection.last_result) ? { last_result: currentProjection.last_result } : {}),
  };

  if (payload.type === "projection.intent_recorded") {
    nextProjection.last_intent = {
      artifact_ref: payload.artifact_ref,
      recorded_at: payload.recorded_at,
      actor: payload.actor,
      idempotency_key: payload.idempotency_key,
      execution_epoch: payload.execution_epoch,
      recorded_from_state: payload.recorded_from_state,
      sequence,
    };
  } else {
    nextProjection.last_result = {
      status: payload.status,
      artifact_ref: payload.artifact_ref,
      recorded_at: payload.recorded_at,
      actor: payload.actor,
      idempotency_key: payload.idempotency_key,
      intent_idempotency_key: payload.intent_idempotency_key,
      execution_epoch: payload.execution_epoch,
      recorded_from_state: payload.recorded_from_state,
      github_pr: payload.github_pr,
      sequence,
    };
  }

  const nextSnapshot = {
    ...snapshot,
    last_sequence: Math.max(Number.isSafeInteger(snapshot.last_sequence) ? snapshot.last_sequence : 0, sequence),
    updated_at: typeof snapshot.updated_at === "string" && snapshot.updated_at > payload.recorded_at ? snapshot.updated_at : payload.recorded_at,
    projections: {
      ...(snapshot.projections || {}),
      github_pr: nextProjection,
    },
  };

  if (payload.type === "projection.result_recorded" && isSuccessfulProjectionResultStatus(payload.status)) {
    nextSnapshot.github = {
      ...(snapshot.github || {}),
      pr: payload.github_pr,
    };
  }

  return nextSnapshot;
}
