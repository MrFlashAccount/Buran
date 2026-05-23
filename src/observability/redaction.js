/** Privacy redaction helpers shared by observability output modules. */
import path from "node:path";

import { isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";

const SECRET_KEY_PATTERN = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session)/i;
const RAW_DOC_KEY_PATTERN = /^(raw|raw_packet|packet_raw|document|documents|body|content|markdown|user_doc|user_docs|completion_payload|worker_payload|transcript|stdout|stderr|session_blob)$/i;
const RAW_PACKET_KEY_PATTERN = /^(packet|packets)$/i;

export const SECRET_VALUE_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\b(?:token|secret|password|authorization|api[_-]?key)=([^\s&]{4,})/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

function clampText(value, max = 240) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizePublicPathContext(context) {
  const root = nonEmptyString(context?.root);
  const label = nonEmptyString(context?.label);
  if (!root || !label) return null;
  return { root: path.resolve(root), label };
}

function normalizePublicPathContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map(normalizePublicPathContext)
    .filter(Boolean)
    .sort((a, b) => b.root.length - a.root.length);
}

function redactSecretsInText(value) {
  let redacted = String(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (/=/.test(match) && !/^Bearer/i.test(match)) return match.replace(/=.*/, "=[REDACTED]");
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      return "[REDACTED_SECRET]";
    });
  }
  return redacted;
}

function safePublicBasename(filePath) {
  const basename = path.posix.basename(String(filePath).replace(/\\/g, "/").replace(/\/+$/g, ""));
  if (!basename || basename === "/" || basename === "." || basename === "..") return "";
  const sanitized = redactSecretsInText(basename);
  if (!path.posix.extname(sanitized)) return "";
  if (sanitized.includes("[REDACTED_SECRET]") || /private|secret|token|password|credential/i.test(sanitized)) return "";
  return sanitized;
}

function redactAbsolutePathMatch(match, prefix = "") {
  const pathText = prefix ? match.slice(prefix.length) : match;
  const basename = safePublicBasename(pathText);
  return `${prefix}<absolute_path>${basename ? `/${basename}` : ""}`;
}

function redactArbitraryAbsolutePaths(value) {
  let redacted = String(value);
  redacted = redacted.replace(/(^|[\s"'([{=,:;])((?:\/(?!\/)[^\s"'<>()[\]{}|`]+){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  redacted = redacted.replace(/(^|[\s"'([{=,:;])([A-Za-z]:\\(?:[^\\\s"'<>()[\]{}|`]+\\?){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  return redacted;
}

function redactTextPaths(value, contexts = []) {
  let redacted = String(value);
  for (const context of normalizePublicPathContexts(contexts)) redacted = redacted.split(context.root).join(context.label);
  return redactArbitraryAbsolutePaths(redacted);
}

export function redactString(value, contexts = [], { max = 500 } = {}) {
  const redacted = redactSecretsInText(redactTextPaths(value, contexts));
  return max && max > 0 ? clampText(redacted, max) : redacted;
}

export function pathRef(filePath) {
  const text = nonEmptyString(filePath);
  if (!text) return null;
  return { basename: path.basename(text), path_hash: sha256Hex(text).slice(0, 12) };
}

export function classifyError(error) {
  const code = nonEmptyString(error?.code).toUpperCase();
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (error instanceof SyntaxError) return "json_parse";
  const name = nonEmptyString(error?.name).toLowerCase();
  if (name.includes("typeerror")) return "type_error";
  if (name.includes("rangeerror")) return "range_error";
  if (name.includes("error")) return "runtime_error";
  return "unknown_error";
}

export function sanitizeError(error, pathContexts = []) {
  return {
    error_kind: classifyError(error),
    name: nonEmptyString(error?.name) || "Error",
    code: nonEmptyString(error?.code),
    message: redactString(error?.message || String(error), pathContexts),
  };
}

export function sanitizeForObservability(value, { depth = 0, pathContexts = [] } = {}) {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, pathContexts);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return sanitizeError(value, pathContexts);
  if (Array.isArray(value)) {
    if (value.length > 20) return [...value.slice(0, 20).map((entry) => sanitizeForObservability(entry, { depth: depth + 1, pathContexts })), `[TRUNCATED_${value.length - 20}_ITEMS]`];
    return value.map((entry) => sanitizeForObservability(entry, { depth: depth + 1, pathContexts }));
  }
  if (!isRecord(value)) return redactString(String(value), pathContexts);

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED_SECRET]";
      continue;
    }
    if (RAW_DOC_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED_RAW_CONTENT]";
      continue;
    }
    if (RAW_PACKET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED_PACKET_DATA]";
      continue;
    }
    output[key] = sanitizeForObservability(entry, { depth: depth + 1, pathContexts });
  }
  return output;
}
