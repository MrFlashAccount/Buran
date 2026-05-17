import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { PLUGIN_ID } from "./constants.js";
import { isRecord, nonEmptyString, resolveMaybeRelative, sha256Hex } from "./utils.js";

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

function timestampPart(clock) {
  return clock().toISOString().replace(/\D/g, "").slice(0, 14) || "undated";
}

function clampText(value, max = 240) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizePublicPathContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map(normalizePublicPathContext)
    .filter(Boolean)
    .sort((a, b) => b.root.length - a.root.length);
}

function redactTextPaths(value, contexts = []) {
  let redacted = String(value);
  for (const context of normalizePublicPathContexts(contexts)) {
    redacted = redacted.split(context.root).join(context.label);
  }
  return redactArbitraryAbsolutePaths(redacted);
}

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

function redactString(value, contexts = [], { max = 500 } = {}) {
  const redacted = redactSecretsInText(redactTextPaths(value, contexts));
  return max && max > 0 ? clampText(redacted, max) : redacted;
}

function safePublicBasename(filePath) {
  const basename = path.posix.basename(String(filePath).replace(/\\/g, "/").replace(/\/+$|\\+$/g, ""));
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

export function buildTraceId(clock = () => new Date()) {
  return `trace_${timestampPart(clock)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

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

function eventName(value) {
  const event = nonEmptyString(value);
  return EVENT_VOCABULARY.has(event) ? event : "diagnostic.report_written";
}

function levelName(value) {
  const level = nonEmptyString(value).toLowerCase();
  return LEVELS.has(level) ? level : "info";
}

function pathRef(filePath) {
  const text = nonEmptyString(filePath);
  if (!text) return null;
  return {
    basename: path.basename(text),
    path_hash: sha256Hex(text).slice(0, 12),
  };
}

function normalizePublicPathContext(context) {
  const root = nonEmptyString(context?.root);
  const label = nonEmptyString(context?.label);
  if (!root || !label) return null;
  return { root: path.resolve(root), label };
}

function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

function publicPathForContext(filePath, context) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(context.root, resolved);
  if (relative === "") return context.label;
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return `${context.label}/${toPosixPath(relative)}`;
  return null;
}

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

export function summarizeArgs(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : typeof rawArgs === "string" ? rawArgs.trim().split(/\s+/).filter(Boolean) : [];
  return args.map((arg, index) => {
    if (index > 0 && ["--packets", "--registry", "--workspace-path"].includes(args[index - 1])) return pathRef(arg);
    if (arg.startsWith("--packets=") || arg.startsWith("--registry=") || arg.startsWith("--workspace-path=")) {
      const [flag, value] = arg.split(/=(.*)/s);
      return { flag, value: pathRef(value) };
    }
    if (SECRET_VALUE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(arg);
    })) return "[REDACTED_SECRET]";
    return redactString(arg);
  });
}

export function summarizeReport(report) {
  if (!isRecord(report)) return {};
  const summary = {
    schema_version: report.schema_version,
    mode: report.mode,
    registry_written: report.registry_written,
    external_side_effects: report.external_side_effects,
  };
  if (isRecord(report.summary)) {
    summary.summary = sanitizeForObservability(report.summary);
  }
  if (isRecord(report.batch)) {
    summary.batch_id = report.batch.batch_id;
    summary.selected_count = report.batch.selected_count;
    summary.accepted_count = report.batch.accepted_count;
    summary.blocked_count = report.batch.blocked_count;
  }
  if (Array.isArray(report.runs)) {
    summary.run_count = report.runs.length;
    summary.run_ids = report.runs.map((run) => run?.run_id).filter(Boolean).slice(0, 20);
  }
  if (report.run_id) summary.run_id = report.run_id;
  if (report.status) summary.status = report.status;
  return sanitizeForObservability(summary);
}

export function correlationFromReport(report) {
  const correlation = {};
  if (!isRecord(report)) return correlation;
  if (report.batch?.batch_id) correlation.batch_id = report.batch.batch_id;
  if (report.run_id) correlation.run_id = report.run_id;
  if (Array.isArray(report.runs) && report.runs.length === 1 && report.runs[0]?.run_id) correlation.run_id = report.runs[0].run_id;
  return correlation;
}

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

  function publicSnapshot() {
    return {
      trace_id: id,
      log_path: sanitizePathForOutput(config.logPath, publicPathContexts),
      diagnostic_report_path: sanitizePathForOutput(diagnosticReportPath, publicPathContexts),
    };
  }

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
