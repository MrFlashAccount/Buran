/**
 * SCM handoff contract helpers for sanitizing and validating durable handoff target data.
 *
 * Responsibility:
 * - redact secrets and absolute paths before projection data becomes durable,
 * - validate `handoff_target` payload shape and parity against the local run contract,
 * - merge projection ledger events back into the registry snapshot.
 *
 * Non-goals:
 * - no transport I/O,
 * - no inference of missing contract fields,
 * - no preservation of sensitive raw values in durable artifacts.
 */
import path from "node:path";

import { isRecord, nonEmptyString } from "../../../shared/primitives.js";

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

function projectionContractString(value, { durable = false } = {}) {
  const text = nonEmptyString(value);
  if (!text) return "";
  return durable ? nonEmptyString(sanitizeProjectionDurableValue(text)) : text;
}

/**
 * Recursively redacts secrets and absolute paths before projection data is stored durably.
 *
 * @param {unknown} value Arbitrary projection value or structure.
 * @param {{depth?: number}} [options]
 * @param {number} [options.depth=0] Current recursion depth guard.
 * @returns {unknown} Durable-safe value with nested strings sanitized.
 */
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
    if (parsed.protocol === "local:") return parsed.hostname === "scm-handoff" && /\/target\/\d+$/.test(parsed.pathname);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return Boolean(parsed.hostname) && /\/pull\/\d+$/.test(parsed.pathname);
    return false;
  } catch {
    return false;
  }
}

/**
 * Appends schema-level validation errors for a projected handoff target payload.
 *
 * @param {object} handoffTarget Candidate handoff target payload.
 * @param {string[]} errors Mutable error accumulator.
 * @param {string} [fieldPath="handoff_target"] Field prefix used in emitted error messages.
 * @returns {void}
 */
export function appendScmHandoffTargetValidationErrors(handoffTarget, errors, fieldPath = "handoff_target") {
  if (!isRecord(handoffTarget)) {
    errors.push(`${fieldPath} must be an object`);
    return;
  }
  if (!Number.isSafeInteger(handoffTarget.number) || handoffTarget.number < 1) errors.push(`${fieldPath}.number must be a positive integer`);
  if (!isValidProjectionUrl(handoffTarget.url)) errors.push(`${fieldPath}.url must be a valid local:// or http(s):// handoff URL`);
  if (!nonEmptyString(handoffTarget.repo)) errors.push(`${fieldPath}.repo must be a non-empty string`);
  if (!hasOwn(handoffTarget, "issue_number") || !(handoffTarget.issue_number === null || Number.isSafeInteger(handoffTarget.issue_number))) {
    errors.push(`${fieldPath}.issue_number must be an integer or null`);
  }
  if (!nonEmptyString(handoffTarget.head_branch)) errors.push(`${fieldPath}.head_branch must be a non-empty string`);
  if (!nonEmptyString(handoffTarget.base_branch)) errors.push(`${fieldPath}.base_branch must be a non-empty string`);
  if (!nonEmptyString(handoffTarget.state)) errors.push(`${fieldPath}.state must be a non-empty string`);
  if (typeof handoffTarget.draft !== "boolean") errors.push(`${fieldPath}.draft must be a boolean`);
  if (!nonEmptyString(handoffTarget.title)) errors.push(`${fieldPath}.title must be a non-empty string`);
  if (hasOwn(handoffTarget, "projection_mode") && typeof handoffTarget.projection_mode !== "string") errors.push(`${fieldPath}.projection_mode must be a string when present`);
  if (hasOwn(handoffTarget, "projected_at") && !isTimestampString(handoffTarget.projected_at)) errors.push(`${fieldPath}.projected_at must be a timestamp string when present`);
  if (hasOwn(handoffTarget, "actor") && !nonEmptyString(handoffTarget.actor)) errors.push(`${fieldPath}.actor must be a non-empty string when present`);
}

/**
 * Appends parity errors when a projected handoff target payload diverges from the local run contract.
 *
 * @param {object} snapshot Local run snapshot that defines repo/issue/branch expectations.
 * @param {object} handoffTarget Candidate handoff target payload.
 * @param {string[]} errors Mutable error accumulator.
 * @param {string} [fieldPath="handoff_target"] Field prefix used in emitted error messages.
 * @param {{durable?: boolean}} [options]
 * @param {boolean} [options.durable=false] Whether expected snapshot strings should be sanitized before comparison.
 * @returns {void}
 */
export function appendScmHandoffTargetContractErrors(snapshot, handoffTarget, errors, fieldPath = "handoff_target", { durable = false } = {}) {
  const scmTarget = isRecord(snapshot?.scm_target) ? snapshot.scm_target : {};
  const legacyProviderTarget = isRecord(snapshot?.github) ? snapshot.github : {};
  const expectedRepo = projectionContractString(scmTarget.repo || legacyProviderTarget.repo, { durable });
  const expectedIssueNumber = Number.isSafeInteger(scmTarget.issue_number)
    ? scmTarget.issue_number
    : Number.isSafeInteger(legacyProviderTarget.issue_number)
      ? legacyProviderTarget.issue_number
      : null;
  const expectedHeadBranch = projectionContractString(scmTarget.intended_branch || legacyProviderTarget.intended_branch, { durable });
  const expectedBaseBranch = projectionContractString(scmTarget.base_branch || legacyProviderTarget.base_branch, { durable });

  if (!expectedRepo) errors.push(`${fieldPath}.repo cannot be verified because scm_target.repo is missing from the local contract`);
  else if (handoffTarget?.repo !== expectedRepo) errors.push(`${fieldPath}.repo must match scm_target.repo`);

  if (expectedIssueNumber === null) errors.push(`${fieldPath}.issue_number cannot be verified because scm_target.issue_number is missing from the local contract`);
  else if (handoffTarget?.issue_number !== expectedIssueNumber) errors.push(`${fieldPath}.issue_number must match scm_target.issue_number`);

  if (!expectedHeadBranch) errors.push(`${fieldPath}.head_branch cannot be verified because scm_target.intended_branch is missing from the local contract`);
  else if (handoffTarget?.head_branch !== expectedHeadBranch) errors.push(`${fieldPath}.head_branch must match scm_target.intended_branch`);

  if (!expectedBaseBranch) errors.push(`${fieldPath}.base_branch cannot be derived from the local run contract`);
  else if (handoffTarget?.base_branch !== expectedBaseBranch) errors.push(`${fieldPath}.base_branch must match scm_target.base_branch`);
}

export function appendProjectedHandoffTargetParityErrors(left, right, errors, leftPath = "handoff_target", rightPath = "projection_ledger.handoff_target.last_result.handoff_target") {
  const comparableKeys = ["number", "url", "repo", "issue_number", "head_branch", "base_branch", "state", "draft", "title"];
  for (const key of comparableKeys) {
    if ((left?.[key] ?? null) !== (right?.[key] ?? null)) errors.push(`${leftPath}.${key} must match ${rightPath}.${key}`);
  }
}

/**
 * Applies a projection ledger event to the in-memory registry snapshot.
 *
 * Successful projection results mirror the projected target into `snapshot.handoff_target` so
 * later stages can consume the same contract-bearing shape. Legacy durable fields are handled by schema compatibility code.
 *
 * @param {object} snapshot Current registry snapshot.
 * @param {object} payload Projection ledger payload being applied.
 * @param {number} sequence Event sequence number assigned by the ledger.
 * @returns {object} Next snapshot state with updated projection bookkeeping.
 */
export function mergeProjectionSnapshot(snapshot, payload, sequence) {
  const currentProjection = isRecord(snapshot.projection_ledger?.handoff_target) ? snapshot.projection_ledger.handoff_target : {};
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
      handoff_target: payload.handoff_target,
      sequence,
    };
  }

  const nextSnapshot = {
    ...snapshot,
    last_sequence: Math.max(Number.isSafeInteger(snapshot.last_sequence) ? snapshot.last_sequence : 0, sequence),
    updated_at: typeof snapshot.updated_at === "string" && snapshot.updated_at > payload.recorded_at ? snapshot.updated_at : payload.recorded_at,
    projection_ledger: {
      ...(snapshot.projection_ledger || {}),
      handoff_target: nextProjection,
    },
  };

  if (payload.type === "projection.result_recorded" && isSuccessfulProjectionResultStatus(payload.status)) {
    nextSnapshot.handoff_target = payload.handoff_target;
  }

  return nextSnapshot;
}
