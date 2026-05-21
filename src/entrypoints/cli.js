/**
 * Shell and plugin command dispatcher for Buran's local integration boundary.
 *
 * Responsibilities:
 * - parse the narrow supported CLI grammar into a structured command contract;
 * - route validated commands into report-producing Buran operations;
 * - attach sanitized observability metadata to both success and failure results.
 *
 * Non-goals:
 * - no autonomous task discovery or remote execution;
 * - no persistence logic beyond delegating to registry-facing modules.
 *
 * Invariants:
 * - unsupported flags fail fast with a thrown parse error;
 * - every completed invocation finalizes an observability trace.
 */
import { acquireLeaseReport, formatBuranReport, intakePacketListFile, normalizeBuranConfig, recoverRegistryReport, releaseLeaseReport, runLocalMissionReport, validatePacketListFile } from "../application/commands.js";
import { createLocalBuranRuntime } from "../composition/local-runtime.js";
import { correlationFromReport, createInvocationObserver, sanitizeError, sanitizePublicReportForOutput, summarizeArgs, summarizeReport } from "../observability/index.js";

/**
 * @typedef {object} BuranCliOptions
 * @property {string} command - Primary CLI command name.
 * @property {string} subcommand - Secondary verb used by lease/lock flows.
 * @property {boolean} json - Whether output should be emitted as JSON.
 * @property {string} packets - Packet-list path provided by the caller.
 * @property {string} registryRoot - Optional registry override path.
 * @property {string} runId - Run identifier for runner or lease operations.
 * @property {string} workspaceId - Workspace lease identifier.
 * @property {string} workspacePath - Optional absolute or relative workspace path.
 * @property {string} ttlMs - Requested lease time-to-live in milliseconds.
 */

/**
 * @typedef {object} RunBuranCliContext
 * @property {object} [pluginConfig={}] - Plugin config forwarded from OpenClaw.
 * @property {string} [workspaceDir=process.cwd()] - Workspace root used for path resolution.
 * @property {string} [stateDir=""] - Optional host-managed state directory.
 * @property {object | null} [apiLogger=null] - Best-effort host logger mirror.
 */

/**
 * Normalize raw CLI input into a token array.
 *
 * @param {string | string[] | unknown} rawArgs - CLI arguments from the shell or plugin host.
 * @returns {string[]} Argument tokens in positional order.
 */
function splitArgs(rawArgs) {
  if (Array.isArray(rawArgs)) return [...rawArgs];
  if (typeof rawArgs !== "string") return [];
  return rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
}

/**
 * Parse supported Buran CLI flags into a stable command object.
 *
 * @param {string | string[] | unknown} rawArgs - Raw command arguments from argv or plugin input.
 * @returns {BuranCliOptions} Structured options consumed by the dispatcher.
 * @throws {Error} When an unsupported flag is encountered.
 */
export function parseBuranArgs(rawArgs) {
  const args = splitArgs(rawArgs);
  const command = args[0] && !args[0].startsWith("-") ? args.shift().toLowerCase() : "help";
  const options = { command, subcommand: "", json: false, packets: "", registryRoot: "", runId: "", workspaceId: "", workspacePath: "", ttlMs: "" };
  if (command === "lease" || command === "lock") {
    options.subcommand = args[0] && !args[0].startsWith("-") ? args.shift().toLowerCase() : "";
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--packets") {
      options.packets = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--packets=")) {
      options.packets = arg.slice("--packets=".length);
      continue;
    }
    if (arg === "--registry") {
      options.registryRoot = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--registry=")) {
      options.registryRoot = arg.slice("--registry=".length);
      continue;
    }
    if (arg === "--run") {
      options.runId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--run=")) {
      options.runId = arg.slice("--run=".length);
      continue;
    }
    if (arg === "--workspace-id") {
      options.workspaceId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace-id=")) {
      options.workspaceId = arg.slice("--workspace-id=".length);
      continue;
    }
    if (arg === "--workspace-path") {
      options.workspacePath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace-path=")) {
      options.workspacePath = arg.slice("--workspace-path=".length);
      continue;
    }
    if (arg === "--ttl-ms") {
      options.ttlMs = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--ttl-ms=")) {
      options.ttlMs = arg.slice("--ttl-ms=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

/**
 * Build human-readable help text for shell and plugin callers.
 *
 * @returns {string} Multiline usage guide for the supported command surface.
 */
export function usageText() {
  return [
    "Usage:",
    "  /buran validate --packets <packet-list.json> [--json]",
    "  /buran intake --packets <packet-list.json> [--registry <path>] [--json]",
    "  /buran run --run <run_id> [--workspace-id <id>] [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]",
    "  /buran recover [--registry <path>] [--json]",
    "  /buran lease acquire --run <run_id> --workspace-id <id> [--workspace-path <path>] [--ttl-ms <ms>] [--registry <path>] [--json]",
    "  /buran lease release --run <run_id> [--registry <path>] [--json]",
    "",
    "Scope: explicit packet lists and local runner skeleton only; no autonomous discovery, remote writes, external systems, PR creation, or worker execution.",
  ].join("\n");
}

/**
 * Resolve the registry root for the current invocation using config defaults plus
 * any explicit command-line override.
 *
 * @param {BuranCliOptions} options - Parsed CLI options.
 * @param {object} pluginConfig - Host plugin config.
 * @param {string} workspaceDir - Workspace root used for relative resolution.
 * @param {string} stateDir - Optional state directory used for runtime storage.
 * @returns {string} Absolute registry root.
 */
function resolveBuranRuntimeConfig(options, pluginConfig, workspaceDir, stateDir) {
  return normalizeBuranConfig(
    { ...pluginConfig, ...(options.registryRoot ? { registryRoot: options.registryRoot } : {}) },
    { workspaceDir, stateDir },
  );
}

function resolveRegistry(options, pluginConfig, workspaceDir, stateDir) {
  return resolveBuranRuntimeConfig(options, pluginConfig, workspaceDir, stateDir).registryRoot;
}

/**
 * Convert parsed command options into a stable observability label.
 *
 * @param {BuranCliOptions | null | undefined} options - Parsed CLI options.
 * @returns {string} Dot-delimited command label for diagnostics.
 */
function commandLabel(options) {
  if (!options) return "cli";
  return options.subcommand ? `${options.command}.${options.subcommand}` : options.command;
}

/**
 * Map CLI commands to the constrained event vocabulary accepted by the
 * observability layer.
 *
 * @param {BuranCliOptions} options - Parsed CLI options.
 * @returns {string} Event name suitable for invocation completion logs.
 */
function commandEvent(options) {
  if (options.command === "validate") return "validation.completed";
  if (options.command === "intake") return "intake.completed";
  if (options.command === "run") return "runner.completed";
  if (options.command === "recover" || options.command === "recovery") return "recovery.completed";
  if ((options.command === "lease" || options.command === "lock") && options.subcommand === "acquire") return "lease.acquire.completed";
  if ((options.command === "lease" || options.command === "lock") && options.subcommand === "release") return "lease.release.completed";
  return "cli.invocation.completed";
}

/**
 * Collect public path-redaction contexts derived from parsed options and the final report.
 *
 * @param {ReturnType<typeof createInvocationObserver>} observer - Active invocation observer.
 * @param {object | null} report - Operation report when available.
 * @param {BuranCliOptions | null} [options=null] - Parsed CLI options.
 * @returns {{root: string, label: string}[]} Path contexts used for public output sanitization.
 */
function cliPathContexts(observer, report, options = null) {
  const contexts = Array.isArray(observer.pathContexts) ? [...observer.pathContexts] : [];
  const registryRoot = report?.registry_root || report?.registry?.root || options?.registryRoot;
  if (registryRoot) contexts.push({ root: registryRoot, label: "<registry>" });
  const workspacePath = report?.lease?.workspace_path || report?.workspace_path || options?.workspacePath;
  if (workspacePath) contexts.push({ root: workspacePath, label: "<workspace>" });
  if (options?.packets) contexts.push({ root: options.packets, label: "<packet_list>" });
  return contexts;
}

/**
 * Register user-supplied paths with the observer before command execution so even
 * early failures can be sanitized consistently.
 *
 * @param {ReturnType<typeof createInvocationObserver>} observer - Active invocation observer.
 * @param {BuranCliOptions} options - Parsed CLI options.
 * @param {object} pluginConfig - Host plugin config.
 * @param {string} workspaceDir - Workspace root.
 * @param {string} stateDir - Optional state directory.
 * @returns {void}
 */
function registerCliOptionPathContexts(observer, options, pluginConfig, workspaceDir, stateDir) {
  if (options?.packets) observer.addPathContext(options.packets, "<packet_list>");
  if (options?.registryRoot) observer.addPathContext(resolveRegistry(options, pluginConfig, workspaceDir, stateDir), "<registry>");
  if (options?.workspacePath) observer.addPathContext(options.workspacePath, "<workspace>");
}

/**
 * Attach a sanitized public error payload to a thrown error object so the shell and
 * plugin boundary can reuse the same redacted message.
 *
 * @param {unknown} error - Original thrown value.
 * @param {{message: string}} sanitizedError - Public error view.
 * @returns {unknown} The same thrown value with public fields attached when mutable.
 */
function attachPublicCliError(error, sanitizedError) {
  if (error && typeof error === "object") {
    error.publicMessage = sanitizedError.message;
    error.publicError = sanitizedError;
  }
  return error;
}

/**
 * Finalize a CLI result by logging completion and appending sanitized observability data.
 *
 * @param {object} params - Result finalization parameters.
 * @param {{ok?: boolean, text?: string, report?: object | null, observability?: object}} params.result - Result object to enrich.
 * @param {BuranCliOptions} params.options - Parsed CLI options.
 * @param {ReturnType<typeof createInvocationObserver>} params.observer - Active invocation observer.
 * @param {"success" | "rejected" | "error"} [params.outcome="success"] - Final invocation outcome.
 * @param {string} [params.reason=""] - Short machine-readable reason.
 * @returns {Promise<{ok?: boolean, text?: string, report?: object | null, observability?: object}>} Finalized result object.
 */
async function finishCliResult({ result, options, observer, outcome = "success", reason = "" }) {
  const durationMs = Math.max(0, Date.now() - observer.startedAtMs);
  const report = result.report || null;
  await observer.log(outcome === "success" ? "info" : "warn", outcome === "success" ? commandEvent(options) : "cli.invocation.rejected", {
    ...correlationFromReport(report),
    outcome,
    reason,
    duration_ms: durationMs,
    context: summarizeReport(report),
  });
  const observability = await observer.finalize({ outcome, reason, report, command: commandLabel(options) });
  if (report && typeof report === "object") {
    report.observability = observability;
    const publicReport = sanitizePublicReportForOutput(report, cliPathContexts(observer, report, options));
    result.text = options.json ? JSON.stringify(publicReport, null, 2) : formatBuranReport(publicReport);
  } else {
    result.observability = observability;
    if (result.text) result.text = `${result.text}\n\nTrace: ${observability.trace_id}\nDiagnostic report: ${observability.diagnostic_report_path}`;
  }
  return result;
}

/**
 * Execute the constrained Buran CLI command set for shell or plugin callers.
 *
 * @param {string | string[] | unknown} rawArgs - Raw arguments from the caller.
 * @param {RunBuranCliContext} [context={}] - Host integration context.
 * @returns {Promise<{ok: boolean, text: string, report?: object | null, observability?: object}>} Result object ready for shell or plugin output.
 * @throws {unknown} Re-throws failures after attaching sanitized public error fields.
 */
export async function runBuranCli(rawArgs, { pluginConfig = {}, workspaceDir = process.cwd(), stateDir = "", apiLogger = null } = {}) {
  const observer = createInvocationObserver({ component: "cli", pluginConfig, workspaceDir, stateDir, apiLogger });
  const baseRuntimeConfig = normalizeBuranConfig(pluginConfig, { workspaceDir, stateDir });
  const runtime = createLocalBuranRuntime({ scmHandoffAdapter: baseRuntimeConfig.scmHandoffAdapter });
  const { registryRepository, workspaceLeaseService, workspacePreparationInspector, registryRecoveryStore, scmHandoffAdapter } = runtime;
  await observer.log("info", "cli.invocation.started", { outcome: "started", context: { args: summarizeArgs(rawArgs) } });
  let options;
  try {
    options = parseBuranArgs(rawArgs);
    registerCliOptionPathContexts(observer, options, pluginConfig, workspaceDir, stateDir);
    await observer.log("debug", "cli.command.parsed", { outcome: "success", context: { command: commandLabel(options), json: options.json } });
  } catch (error) {
    const sanitizedError = sanitizeError(error, observer.pathContexts);
    await observer.log("error", "cli.invocation.failed", {
      outcome: "error",
      error_kind: sanitizedError.error_kind,
      duration_ms: Math.max(0, Date.now() - observer.startedAtMs),
      context: { error: sanitizedError },
    });
    await observer.finalize({ outcome: "error", reason: sanitizedError.message, error, command: "parse" });
    throw attachPublicCliError(error, sanitizedError);
  }
  if (options.command === "help" || options.command === "") {
    return finishCliResult({ result: { ok: false, text: usageText() }, options, observer, outcome: "rejected", reason: "help_requested" });
  }

  try {
    if (options.command === "validate") {
      if (!options.packets) {
        return finishCliResult({
          result: { ok: false, text: `${usageText()}\n\nError: --packets <path> is required; autonomous task discovery is not supported.` },
          options,
          observer,
          outcome: "rejected",
          reason: "missing_packets",
        });
      }
      const report = await validatePacketListFile(options.packets);
      return finishCliResult({ result: { ok: true, report }, options, observer });
    }

    if (options.command === "intake") {
      if (!options.packets) {
        return finishCliResult({
          result: { ok: false, text: `${usageText()}\n\nError: --packets <path> is required; autonomous task discovery is not supported.` },
          options,
          observer,
          outcome: "rejected",
          reason: "missing_packets",
        });
      }
      const registryRoot = resolveRegistry(options, pluginConfig, workspaceDir, stateDir);
      const report = await intakePacketListFile(options.packets, { registryRoot, registryRepository });
      return finishCliResult({ result: { ok: true, report }, options, observer });
    }

    if (options.command === "run") {
      if (!options.runId) {
        return finishCliResult({
          result: { ok: false, text: `${usageText()}\n\nError: run requires --run <run_id>.` },
          options,
          observer,
          outcome: "rejected",
          reason: "missing_runner_arguments",
        });
      }
      const runtimeConfig = resolveBuranRuntimeConfig(options, pluginConfig, workspaceDir, stateDir);
      const report = await runLocalMissionReport({
        registryRoot: runtimeConfig.registryRoot,
        runId: options.runId,
        workspaceId: options.workspaceId,
        workspacePath: options.workspacePath,
        ttlMs: options.ttlMs,
        implementationDispatchAdapter: runtimeConfig.implementationDispatchAdapter,
        scmHandoffAdapter: runtimeConfig.scmHandoffAdapter || scmHandoffAdapter,
        registryRepository,
        workspaceLeaseService,
        workspacePreparationInspector,
      });
      return finishCliResult({ result: { ok: true, report }, options, observer });
    }

    if (options.command === "recover" || options.command === "recovery") {
      const registryRoot = resolveRegistry(options, pluginConfig, workspaceDir, stateDir);
      const report = await recoverRegistryReport({ registryRoot, registryRepository, workspaceLeaseService, registryRecoveryStore });
      return finishCliResult({ result: { ok: true, report }, options, observer });
    }

    if (options.command === "lease" || options.command === "lock") {
      const registryRoot = resolveRegistry(options, pluginConfig, workspaceDir, stateDir);
      if (options.subcommand === "acquire") {
        if (!options.runId || !options.workspaceId) {
          return finishCliResult({
            result: { ok: false, text: `${usageText()}\n\nError: lease acquire requires --run <run_id> and --workspace-id <id>.` },
            options,
            observer,
            outcome: "rejected",
            reason: "missing_lease_acquire_arguments",
          });
        }
        const report = await acquireLeaseReport({
          registryRoot,
          runId: options.runId,
          workspaceId: options.workspaceId,
          workspacePath: options.workspacePath,
          ttlMs: options.ttlMs,
          workspaceLeaseService,
        });
        return finishCliResult({ result: { ok: true, report }, options, observer });
      }
      if (options.subcommand === "release") {
        if (!options.runId) {
          return finishCliResult({
            result: { ok: false, text: `${usageText()}\n\nError: lease release requires --run <run_id>.` },
            options,
            observer,
            outcome: "rejected",
            reason: "missing_lease_release_arguments",
          });
        }
        const report = await releaseLeaseReport({ registryRoot, runId: options.runId, workspaceLeaseService });
        return finishCliResult({ result: { ok: true, report }, options, observer });
      }
      return finishCliResult({
        result: { ok: false, text: `${usageText()}\n\nError: lease command requires acquire or release.` },
        options,
        observer,
        outcome: "rejected",
        reason: "missing_lease_subcommand",
      });
    }

    return finishCliResult({
      result: { ok: false, text: `${usageText()}\n\nError: unknown command ${options.command}` },
      options,
      observer,
      outcome: "rejected",
      reason: "unknown_command",
    });
  } catch (error) {
    const sanitizedError = sanitizeError(error, cliPathContexts(observer, null, options));
    await observer.log("error", "cli.invocation.failed", {
      outcome: "error",
      error_kind: sanitizedError.error_kind,
      duration_ms: Math.max(0, Date.now() - observer.startedAtMs),
      context: { command: commandLabel(options), error: sanitizedError },
    });
    await observer.finalize({ outcome: "error", reason: sanitizedError.message, report: null, error, command: commandLabel(options) });
    throw attachPublicCliError(error, sanitizedError);
  }
}
