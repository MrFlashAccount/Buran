import { acquireLeaseReport, formatBuranReport, intakePacketListFile, normalizeBuranConfig, recoverRegistryReport, releaseLeaseReport, runLocalMissionReport, validatePacketListFile } from "./buran.js";
import { correlationFromReport, createInvocationObserver, sanitizeError, sanitizePublicReportForOutput, summarizeArgs, summarizeReport } from "./observability.js";

function splitArgs(rawArgs) {
  if (Array.isArray(rawArgs)) return [...rawArgs];
  if (typeof rawArgs !== "string") return [];
  return rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
}

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

function resolveRegistry(options, pluginConfig, workspaceDir, stateDir) {
  return normalizeBuranConfig(
    { ...pluginConfig, ...(options.registryRoot ? { registryRoot: options.registryRoot } : {}) },
    { workspaceDir, stateDir },
  ).registryRoot;
}

function commandLabel(options) {
  if (!options) return "cli";
  return options.subcommand ? `${options.command}.${options.subcommand}` : options.command;
}

function commandEvent(options) {
  if (options.command === "validate") return "validation.completed";
  if (options.command === "intake") return "intake.completed";
  if (options.command === "run") return "runner.completed";
  if (options.command === "recover" || options.command === "recovery") return "recovery.completed";
  if ((options.command === "lease" || options.command === "lock") && options.subcommand === "acquire") return "lease.acquire.completed";
  if ((options.command === "lease" || options.command === "lock") && options.subcommand === "release") return "lease.release.completed";
  return "cli.invocation.completed";
}

function cliPathContexts(observer, report, options = null) {
  const contexts = Array.isArray(observer.pathContexts) ? [...observer.pathContexts] : [];
  const registryRoot = report?.registry_root || report?.registry?.root || options?.registryRoot;
  if (registryRoot) contexts.push({ root: registryRoot, label: "<registry>" });
  const workspacePath = report?.lease?.workspace_path || report?.workspace_path || options?.workspacePath;
  if (workspacePath) contexts.push({ root: workspacePath, label: "<workspace>" });
  if (options?.packets) contexts.push({ root: options.packets, label: "<packet_list>" });
  return contexts;
}

function registerCliOptionPathContexts(observer, options, pluginConfig, workspaceDir, stateDir) {
  if (options?.packets) observer.addPathContext(options.packets, "<packet_list>");
  if (options?.registryRoot) observer.addPathContext(resolveRegistry(options, pluginConfig, workspaceDir, stateDir), "<registry>");
  if (options?.workspacePath) observer.addPathContext(options.workspacePath, "<workspace>");
}

function attachPublicCliError(error, sanitizedError) {
  if (error && typeof error === "object") {
    error.publicMessage = sanitizedError.message;
    error.publicError = sanitizedError;
  }
  return error;
}

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

export async function runBuranCli(rawArgs, { pluginConfig = {}, workspaceDir = process.cwd(), stateDir = "", apiLogger = null } = {}) {
  const observer = createInvocationObserver({ component: "cli", pluginConfig, workspaceDir, stateDir, apiLogger });
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
      const report = await intakePacketListFile(options.packets, { registryRoot });
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
      const registryRoot = resolveRegistry(options, pluginConfig, workspaceDir, stateDir);
      const report = await runLocalMissionReport({
        registryRoot,
        runId: options.runId,
        workspaceId: options.workspaceId,
        workspacePath: options.workspacePath,
        ttlMs: options.ttlMs,
      });
      return finishCliResult({ result: { ok: true, report }, options, observer });
    }

    if (options.command === "recover" || options.command === "recovery") {
      const registryRoot = resolveRegistry(options, pluginConfig, workspaceDir, stateDir);
      const report = await recoverRegistryReport({ registryRoot });
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
        const report = await releaseLeaseReport({ registryRoot, runId: options.runId });
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
