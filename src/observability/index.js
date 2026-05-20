/**
 * Sanitized operational logging and diagnostic-report helpers for Buran.
 *
 * Responsibilities:
 * - redact secrets, raw packet content, and private filesystem paths before exposure;
 * - normalize the on-disk observability layout used by CLI and plugin invocations;
 * - create per-invocation observers that append JSONL logs and diagnostic reports.
 *
 * Non-goals:
 * - no outbound telemetry or remote log shipping;
 * - no replacement for core business reports emitted by runner and registry modules.
 *
 * Invariants:
 * - public observability output must stay privacy-safe;
 * - diagnostic artifacts are written locally under the resolved observability root.
 */
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { PLUGIN_ID } from "../execution-runs/constants.js";
import { isRecord, nonEmptyString, resolveMaybeRelative, sha256Hex } from "../shared/primitives.js";
import { correlationFromReport, summarizeReport } from "./public-output.js";

/** @type {string} Schema version written into operational log lines and diagnostic reports. */
export const OBSERVABILITY_SCHEMA_VERSION = "observability.v1";

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const EVENT_VOCABULARY = new Set([
  "cli.invocation.started",
  "cli.command.parsed",
  "cli.invocation.rejected",
  "cli.invocation.completed",
  "cli.invocation.failed",
  "validation.completed",
  "intake.completed",
  "runner.completed",
  "recovery.completed",
  "lease.acquire.completed",
  "lease.release.completed",
  "diagnostic.report_written",
]);

const SECRET_KEY_PATTERN = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session)/i;
const RAW_DOC_KEY_PATTERN = /^(raw|raw_packet|packet_raw|document|documents|body|content|markdown|user_doc|user_docs)$/i;
const RAW_PACKET_KEY_PATTERN = /^(packet|packets)$/i;
const SECRET_VALUE_PATTERNS = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{16,}/g,
  /\b(?:token|secret|password|authorization|api[_-]?key)=([^\s&]{4,})/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/**
 * @typedef {{root: string, label: string}} PublicPathContext
 */

/**
 * @typedef {{error_kind: string, name: string, code: string, message: string}} SanitizedError
 */

/**
 * @typedef {object} ObservabilityConfig
 * @property {string} root - Resolved observability storage root.
 * @property {string} logsDir - Directory containing operational JSONL logs.
 * @property {string} diagnosticsDir - Directory containing per-trace diagnostic reports.
 * @property {string} logPath - JSONL log file path.
 */

/**
 * @typedef {object} InvocationObserver
 * @property {string} traceId - Stable trace identifier for a single invocation.
 * @property {string} component - Component name recorded in logs.
 * @property {string} command - Logical command label for the invocation.
 * @property {string} logPath - Sanitized public log path.
 * @property {string} diagnosticReportPath - Sanitized public diagnostic report path.
 * @property {string} rawLogPath - Absolute operational log path.
 * @property {string} rawDiagnosticReportPath - Absolute diagnostic report path.
 * @property {PublicPathContext[]} pathContexts - Registered public path-redaction contexts.
 * @property {(root: string, label: string) => void} addPathContext - Register an additional path-redaction context.
 * @property {(filePath: string) => string} sanitizePath - Sanitize a single filesystem path.
 * @property {(value: unknown) => unknown} sanitizePaths - Sanitize every path-shaped string in a nested value.
 * @property {string} startedAt - ISO timestamp marking observer creation.
 * @property {number} startedAtMs - Epoch timestamp used for duration calculations.
 * @property {() => {trace_id: string, log_path: string, diagnostic_report_path: string}} snapshot - Return the current public observer snapshot.
 * @property {(level: string, event: string, fields?: object) => Promise<object>} log - Append a sanitized operational log entry.
 * @property {(params?: {outcome?: string, reason?: string, report?: object | null, error?: unknown, command?: string}) => Promise<{trace_id: string, log_path: string, diagnostic_report_path: string}>} finalize - Persist the diagnostic report once and return its public snapshot.
 */

/**
 * Format the current clock timestamp for trace IDs.
 *
 * @param {() => Date} clock - Clock function used for deterministic testing.
 * @returns {string} Compact UTC timestamp or {@code undated} when unavailable.
 */
function timestampPart(clock) {
  return clock().toISOString().replace(/\D/g, "").slice(0, 14) || "undated";
}

/**
 * Clamp arbitrary text for compact log emission.
 *
 * @param {unknown} value - Value to stringify and clamp.
 * @param {number} [max=240] - Maximum string length before truncation.
 * @returns {string} Stringified value with an ellipsis when truncated.
 */
function clampText(value, max = 240) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Normalize and sort public path contexts by descending root length so more specific
 * replacements win before broader workspace/state replacements.
 *
 * @param {unknown} contexts - Candidate public path contexts.
 * @returns {PublicPathContext[]} Normalized contexts safe for path replacement.
 */
function normalizePublicPathContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map(normalizePublicPathContext)
    .filter(Boolean)
    .sort((a, b) => b.root.length - a.root.length);
}

/**
 * Replace configured public roots inside free-form text before fallback absolute-path redaction.
 *
 * @param {unknown} value - Free-form text that may contain filesystem paths.
 * @param {PublicPathContext[]} [contexts=[]] - Public path replacement contexts.
 * @returns {string} Redacted text with public placeholders.
 */
function redactTextPaths(value, contexts = []) {
  let redacted = String(value);
  for (const context of normalizePublicPathContexts(contexts)) {
    redacted = redacted.split(context.root).join(context.label);
  }
  return redactArbitraryAbsolutePaths(redacted);
}

/**
 * Remove token- and secret-shaped substrings from free-form text.
 *
 * @param {unknown} value - Text that may contain secrets.
 * @returns {string} Redacted text.
 */
function redactSecretsInText(value) {
  let redacted = String(value);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (/=/.test(match) && !/^Bearer/i.test(match)) {
        return match.replace(/=.*/, "=[REDACTED]");
      }
      if (/^Bearer/i.test(match)) return "Bearer [REDACTED]";
      return "[REDACTED_SECRET]";
    });
  }
  return redacted;
}

/**
 * Apply secret/path redaction plus optional length clamping to a string.
 *
 * @param {unknown} value - Value to stringify and redact.
 * @param {PublicPathContext[]} [contexts=[]] - Public path replacement contexts.
 * @param {{max?: number}} [options={}] - Output sizing controls.
 * @returns {string} Redacted string.
 */
function redactString(value, contexts = [], { max = 500 } = {}) {
  const redacted = redactSecretsInText(redactTextPaths(value, contexts));
  return max && max > 0 ? clampText(redacted, max) : redacted;
}

/**
 * Derive a safe basename for public path placeholders.
 *
 * @param {unknown} filePath - Candidate filesystem path.
 * @returns {string} Safe basename with extension, or an empty string when the basename is not safe to expose.
 */
function safePublicBasename(filePath) {
  const basename = path.posix.basename(String(filePath).replace(/\\/g, "/").replace(/\/+$|\\+$/g, ""));
  if (!basename || basename === "/" || basename === "." || basename === "..") return "";
  const sanitized = redactSecretsInText(basename);
  if (!path.posix.extname(sanitized)) return "";
  if (sanitized.includes("[REDACTED_SECRET]") || /private|secret|token|password|credential/i.test(sanitized)) return "";
  return sanitized;
}

/**
 * Replace a detected absolute path with a generic placeholder while preserving a safe basename when possible.
 *
 * @param {string} match - Entire regex match including any delimiter prefix.
 * @param {string} [prefix=""] - Delimiter prefix that should be preserved verbatim.
 * @returns {string} Redacted path placeholder.
 */
function redactAbsolutePathMatch(match, prefix = "") {
  const pathText = prefix ? match.slice(prefix.length) : match;
  const basename = safePublicBasename(pathText);
  return `${prefix}<absolute_path>${basename ? `/${basename}` : ""}`;
}

/**
 * Detect Unix and Windows absolute paths embedded in free-form text and redact them.
 *
 * @param {unknown} value - Free-form text that may contain absolute paths.
 * @returns {string} Text with absolute paths replaced by placeholders.
 */
function redactArbitraryAbsolutePaths(value) {
  let redacted = String(value);
  redacted = redacted.replace(/(^|[\s"'([{=,:;])((?:\/(?!\/)[^\s"'<>()[\]{}|`]+){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  redacted = redacted.replace(/(^|[\s"'([{=,:;])([A-Za-z]:\\(?:[^\\\s"'<>()[\]{}|`]+\\?){2,})/g, (match, prefix) => redactAbsolutePathMatch(match, prefix));
  return redacted;
}

/**
 * Recursively sanitize arbitrary values before they are written to local observability artifacts.
 *
 * @param {unknown} value - Value to sanitize.
 * @param {{depth?: number, pathContexts?: PublicPathContext[]}} [options={}] - Recursion and path-redaction settings.
 * @returns {unknown} Privacy-safe clone of the input value.
 */
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

/**
 * Classify an error into the small public taxonomy used by diagnostics.
 *
 * @param {unknown} error - Error-like value.
 * @returns {string} Public error kind.
 */
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

/**
 * Produce a compact public error object safe for logs, diagnostics, and CLI output.
 *
 * @param {unknown} error - Error-like value.
 * @param {PublicPathContext[]} [pathContexts=[]] - Path contexts used for path redaction.
 * @returns {SanitizedError} Public error payload.
 */
export function sanitizeError(error, pathContexts = []) {
  return {
    error_kind: classifyError(error),
    name: nonEmptyString(error?.name) || "Error",
    code: nonEmptyString(error?.code),
    message: redactString(error?.message || String(error), pathContexts),
  };
}

/**
 * Resolve the local directory layout used for observability artifacts.
 *
 * @param {object} [raw={}] - Raw plugin configuration.
 * @param {{workspaceDir?: string, stateDir?: string}} [context={}] - Host path context.
 * @returns {ObservabilityConfig} Resolved observability storage locations.
 */
export function normalizeObservabilityConfig(raw = {}, { workspaceDir = process.cwd(), stateDir = "" } = {}) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const configuredRoot = nonEmptyString(config.observabilityRoot);
  const defaultRoot = stateDir
    ? path.join(stateDir, "plugins", PLUGIN_ID)
    : path.join(workspaceDir, ".openclaw-runtime", "plugins", PLUGIN_ID);
  const root = configuredRoot ? resolveMaybeRelative(workspaceDir, configuredRoot) : defaultRoot;
  return {
    root,
    logsDir: path.join(root, "logs"),
    diagnosticsDir: path.join(root, "diagnostics"),
    logPath: path.join(root, "logs", "operational.jsonl"),
  };
}

/**
 * Create a unique per-invocation trace identifier.
 *
 * @param {() => Date} [clock=() => new Date()] - Clock function for deterministic testing.
 * @returns {string} Trace identifier used across logs and diagnostics.
 */
export function buildTraceId(clock = () => new Date()) {
  return `trace_${timestampPart(clock)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Mirror a sanitized log entry into the host API logger when one is available.
 *
 * @param {object | null | undefined} apiLogger - Host-provided logger surface.
 * @param {object} entry - Sanitized log entry.
 * @returns {void}
 */
function mirrorToApiLogger(apiLogger, entry) {
  if (!apiLogger || typeof apiLogger !== "object") return;
  const level = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : entry.level === "debug" ? "debug" : "info";
  try {
    if (typeof apiLogger[level] === "function") {
      apiLogger[level](entry);
      return;
    }
    if (typeof apiLogger.log === "function") apiLogger.log(entry);
  } catch {
    // Best-effort boundary only. Local JSONL logging remains authoritative for operational diagnostics.
  }
}

/**
 * Constrain arbitrary event strings to the supported public vocabulary.
 *
 * @param {unknown} value - Candidate event name.
 * @returns {string} Known event name or the fallback diagnostic event.
 */
function eventName(value) {
  const event = nonEmptyString(value);
  return EVENT_VOCABULARY.has(event) ? event : "diagnostic.report_written";
}

/**
 * Constrain arbitrary log levels to the supported set.
 *
 * @param {unknown} value - Candidate level.
 * @returns {string} Supported log level.
 */
function levelName(value) {
  const level = nonEmptyString(value).toLowerCase();
  return LEVELS.has(level) ? level : "info";
}

/**
 * Create a minimal public path reference for inclusion in sanitized diagnostics.
 *
 * @param {unknown} filePath - Filesystem path.
 * @returns {{basename: string, path_hash: string} | null} Public path reference or {@code null} when no path is available.
 */
function pathRef(filePath) {
  const text = nonEmptyString(filePath);
  if (!text) return null;
  return {
    basename: path.basename(text),
    path_hash: sha256Hex(text).slice(0, 12),
  };
}

/**
 * Normalize a single public path context.
 *
 * @param {Partial<PublicPathContext> | null | undefined} context - Candidate path context.
 * @returns {PublicPathContext | null} Normalized context or {@code null} when incomplete.
 */
function normalizePublicPathContext(context) {
  const root = nonEmptyString(context?.root);
  const label = nonEmptyString(context?.label);
  if (!root || !label) return null;
  return { root: path.resolve(root), label };
}

/**
 * Convert the current platform path separator into POSIX separators for public output.
 *
 * @param {unknown} value - Path-like value.
 * @returns {string} POSIX-style path.
 */
function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

/**
 * Render a path relative to a public context root when possible.
 *
 * @param {string} filePath - Absolute filesystem path.
 * @param {PublicPathContext} context - Path context root and label.
 * @returns {string | null} Public placeholder path or {@code null} when the path is outside the context root.
 */
function publicPathForContext(filePath, context) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(context.root, resolved);
  if (relative === "") return context.label;
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return `${context.label}/${toPosixPath(relative)}`;
  return null;
}

/**
 * Sanitize a filesystem path for user-visible output.
 *
 * @param {unknown} filePath - Path-like value.
 * @param {PublicPathContext[]} [contexts=[]] - Registered public path contexts.
 * @returns {string} Public path placeholder or redacted fallback string.
 */
export function sanitizePathForOutput(filePath, contexts = []) {
  const text = nonEmptyString(filePath);
  if (!text) return text;
  const publicContexts = normalizePublicPathContexts(contexts);

  if (path.isAbsolute(text)) {
    for (const context of publicContexts) {
      const publicPath = publicPathForContext(text, context);
      if (publicPath) return publicPath;
    }
  }

  let redacted = text;
  for (const context of publicContexts) {
    redacted = redacted.split(context.root).join(context.label);
  }
  return redactArbitraryAbsolutePaths(redacted);
}

/**
 * Recursively sanitize path-like strings within nested output values.
 *
 * @param {unknown} value - Value to traverse.
 * @param {PublicPathContext[]} [contexts=[]] - Registered public path contexts.
 * @param {{depth?: number}} [options={}] - Recursion controls.
 * @returns {unknown} Value with path-like strings sanitized.
 */
export function sanitizePathsForOutput(value, contexts = [], { depth = 0 } = {}) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizePathForOutput(value, contexts);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizePathsForOutput(entry, contexts, { depth: depth + 1 }));
  if (!isRecord(value)) return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sanitizePathsForOutput(entry, contexts, { depth: depth + 1 });
  }
  return output;
}

/**
 * Recursively sanitize a report that will be returned to end users.
 *
 * Compared with {@link sanitizeForObservability}, this variant keeps full strings where
 * possible while still redacting secrets and path details.
 *
 * @param {unknown} value - Value to sanitize for user-facing output.
 * @param {PublicPathContext[]} [contexts=[]] - Registered public path contexts.
 * @param {{depth?: number}} [options={}] - Recursion controls.
 * @returns {unknown} Public report clone.
 */
export function sanitizePublicReportForOutput(value, contexts = [], { depth = 0 } = {}) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, contexts, { max: 0 });
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicReportForOutput(entry, contexts, { depth: depth + 1 }));
  if (!isRecord(value)) return redactString(String(value), contexts, { max: 0 });
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
    output[key] = sanitizePublicReportForOutput(entry, contexts, { depth: depth + 1 });
  }
  return output;
}

/**
 * Build a privacy-safe summary of raw CLI arguments for logging.
 *
 * @param {string | string[] | unknown} rawArgs - Raw CLI arguments.
 * @returns {Array<string | object>} Sanitized argument summary.
 */
export { correlationFromReport, summarizeArgs, summarizeReport } from "./public-output.js";

export function createInvocationObserver({
  component = "cli",
  command = "",
  pluginConfig = {},
  workspaceDir = process.cwd(),
  stateDir = "",
  apiLogger = null,
  clock = () => new Date(),
  traceId = "",
} = {}) {
  const config = normalizeObservabilityConfig(pluginConfig, { workspaceDir, stateDir });
  const id = nonEmptyString(traceId) || buildTraceId(clock);
  const startedAtMs = Date.now();
  const startedAt = clock().toISOString();
  const diagnosticReportPath = path.join(config.diagnosticsDir, `${id}.json`);
  const publicPathContexts = [
    { root: config.root, label: "<observability>" },
    { root: stateDir, label: "<state>" },
    { root: workspaceDir, label: "<workspace>" },
  ];
  let finalized = false;

  /**
   * @returns {{trace_id: string, log_path: string, diagnostic_report_path: string}} Public observer snapshot.
   */
  function publicSnapshot() {
    return {
      trace_id: id,
      log_path: sanitizePathForOutput(config.logPath, publicPathContexts),
      diagnostic_report_path: sanitizePathForOutput(diagnosticReportPath, publicPathContexts),
    };
  }

  /** @type {InvocationObserver} */
  const observer = {
    traceId: id,
    component,
    command,
    logPath: sanitizePathForOutput(config.logPath, publicPathContexts),
    diagnosticReportPath: sanitizePathForOutput(diagnosticReportPath, publicPathContexts),
    rawLogPath: config.logPath,
    rawDiagnosticReportPath: diagnosticReportPath,
    pathContexts: publicPathContexts,
    addPathContext(root, label) {
      const context = normalizePublicPathContext({ root, label });
      if (!context) return;
      if (!publicPathContexts.some((entry) => entry.root === context.root && entry.label === context.label)) publicPathContexts.push(context);
    },
    sanitizePath(filePath) {
      return sanitizePathForOutput(filePath, publicPathContexts);
    },
    sanitizePaths(value) {
      return sanitizePathsForOutput(value, publicPathContexts);
    },
    startedAt,
    startedAtMs,
    snapshot() {
      return publicSnapshot();
    },
    async log(level, event, fields = {}) {
      const sanitizedFields = sanitizeForObservability(fields, { pathContexts: publicPathContexts });
      const entry = {
        schema_version: OBSERVABILITY_SCHEMA_VERSION,
        timestamp: clock().toISOString(),
        level: levelName(level),
        component: nonEmptyString(sanitizedFields.component) || component,
        event: eventName(event),
        trace_id: id,
      };
      for (const key of ["batch_id", "run_id", "outcome", "reason", "error_kind", "duration_ms"]) {
        if (sanitizedFields[key] !== undefined && sanitizedFields[key] !== "") entry[key] = sanitizedFields[key];
      }
      if (sanitizedFields.context !== undefined) entry.context = sanitizedFields.context;
      await fs.mkdir(path.dirname(config.logPath), { recursive: true });
      await fs.appendFile(config.logPath, `${JSON.stringify(entry)}\n`, "utf8");
      mirrorToApiLogger(apiLogger, entry);
      return entry;
    },
    async finalize({ outcome, reason = "", report = null, error = null, command: finalCommand = "" } = {}) {
      if (finalized) return this.snapshot();
      finalized = true;
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      const reportSummary = sanitizeForObservability(summarizeReport(report), { pathContexts: publicPathContexts });
      const sanitizedError = error ? sanitizeError(error, publicPathContexts) : null;
      const diagnostic = {
        schema_version: OBSERVABILITY_SCHEMA_VERSION,
        trace_id: id,
        component,
        command: nonEmptyString(finalCommand) || command,
        started_at: startedAt,
        finished_at: clock().toISOString(),
        duration_ms: durationMs,
        outcome,
        reason: redactString(reason, publicPathContexts),
        error_kind: sanitizedError?.error_kind || "",
        error: sanitizedError,
        report_summary: reportSummary,
        paths: {
          log_path: sanitizePathForOutput(config.logPath, publicPathContexts),
          diagnostic_report_path: sanitizePathForOutput(diagnosticReportPath, publicPathContexts),
        },
        external_telemetry: false,
      };
      await fs.mkdir(config.diagnosticsDir, { recursive: true });
      await fs.writeFile(diagnosticReportPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
      await this.log(outcome === "success" ? "info" : outcome === "rejected" ? "warn" : "error", "diagnostic.report_written", {
        ...correlationFromReport(report),
        outcome,
        reason,
        error_kind: sanitizedError?.error_kind || "",
        duration_ms: durationMs,
        context: { diagnostic_report: pathRef(diagnosticReportPath) },
      });
      return this.snapshot();
    },
  };

  return observer;
}
