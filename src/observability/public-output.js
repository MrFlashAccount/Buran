/** Public report and argument summary helpers. */
import { isRecord } from "../shared/primitives.js";
import { pathRef, redactString, sanitizeForObservability, SECRET_VALUE_PATTERNS } from "./redaction.js";

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

/**
 * Reduce a full Buran operation report to the stable fields needed for diagnostics.
 *
 * @param {unknown} report - Full operation report.
 * @returns {object} Sanitized report summary.
 */
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

/**
 * Extract correlation identifiers from a report for log stitching.
 *
 * @param {unknown} report - Operation report.
 * @returns {object} Correlation fields suitable for structured logging.
 */
export function correlationFromReport(report) {
  const correlation = {};
  if (!isRecord(report)) return correlation;
  if (report.batch?.batch_id) correlation.batch_id = report.batch.batch_id;
  if (report.run_id) correlation.run_id = report.run_id;
  if (Array.isArray(report.runs) && report.runs.length === 1 && report.runs[0]?.run_id) correlation.run_id = report.runs[0].run_id;
  return correlation;
}

/**
 * Create a per-invocation observer that owns local JSONL logging plus a final diagnostic report.
 *
 * @param {object} [options={}] - Observer configuration.
 * @param {string} [options.component="cli"] - Component name written to each log entry.
 * @param {string} [options.command=""] - Initial command label.
 * @param {object} [options.pluginConfig={}] - Plugin config used to resolve the observability root.
 * @param {string} [options.workspaceDir=process.cwd()] - Workspace root for relative path resolution.
 * @param {string} [options.stateDir=""] - Optional host state directory.
 * @param {object | null} [options.apiLogger=null] - Best-effort host logger mirror.
 * @param {() => Date} [options.clock=() => new Date()] - Clock function for deterministic testing.
 * @param {string} [options.traceId=""] - Optional precomputed trace identifier.
 * @returns {InvocationObserver} Observer API for logging and finalization.
 */
