import { promises as fs } from "node:fs";
import path from "node:path";

import { PLUGIN_ID, SCHEMA_VERSION } from "./constants.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "./locks.js";
import { normalizePacketList, summarizePacketReports } from "./packet-sufficiency.js";
import { createBatchFromPacketReports, createRunFromPacketReport, getRegistryPaths } from "./registry.js";
import { formatRecoveryReport, recoverRegistry } from "./recovery.js";
import { runLocalMission } from "./runner.js";
import { nonEmptyString, resolveMaybeRelative } from "./utils.js";

export function normalizeBuranConfig(raw = {}, { workspaceDir = process.cwd(), stateDir = "" } = {}) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const configuredRoot = nonEmptyString(config.registryRoot);
  const defaultRoot = stateDir
    ? path.join(stateDir, "plugins", PLUGIN_ID, "registry")
    : path.join(workspaceDir, ".openclaw-runtime", "plugins", PLUGIN_ID, "registry");
  return {
    registryRoot: configuredRoot ? resolveMaybeRelative(workspaceDir, configuredRoot) : defaultRoot,
  };
}

export async function readPacketListFile(packetListPath) {
  if (!packetListPath) throw new Error("--packets <path> is required; autonomous task discovery is not supported");
  const raw = await fs.readFile(packetListPath, "utf8");
  const parsed = JSON.parse(raw);
  const packets = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.packets) ? parsed.packets : null;
  if (!packets) throw new Error("packet list must be a JSON array or an object with a packets array");
  return parsed;
}

export async function validatePacketListFile(packetListPath) {
  const parsed = await readPacketListFile(packetListPath);
  const reports = normalizePacketList(parsed, { sourcePath: packetListPath });
  return {
    schema_version: SCHEMA_VERSION,
    mode: "dry_validation",
    registry_written: false,
    summary: summarizePacketReports(reports),
    packets: reports.map(toPublicPacketReport),
  };
}

export async function intakePacketListFile(packetListPath, { registryRoot, clock = () => new Date() } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for intake");
  const parsed = await readPacketListFile(packetListPath);
  const reports = normalizePacketList(parsed, { sourcePath: packetListPath });
  const runs = [];
  const createdAt = clock().toISOString();
  const intakeClock = () => new Date(createdAt);

  for (const report of reports) {
    const created = await createRunFromPacketReport(report, { registryRoot, clock: intakeClock });
    runs.push({
      run_id: created.run.run_id,
      task_id: created.run.task_id,
      state: created.run.state,
      run_dir: created.run_dir,
      missing_fields: created.run.packet.missing_fields,
    });
  }
  const batch = await createBatchFromPacketReports(reports, runs, {
    registryRoot,
    createdAt,
  });

  return {
    schema_version: SCHEMA_VERSION,
    mode: "intake",
    registry_written: true,
    registry: getRegistryPaths(registryRoot),
    summary: summarizePacketReports(reports),
    packets: reports.map(toPublicPacketReport),
    batch,
    runs,
  };
}

export function toPublicPacketReport(report) {
  return {
    task_id: report.task_id,
    run_id: report.run_id || "",
    sufficiency_status: report.sufficiency_status,
    sufficient: report.sufficient,
    missing_fields: report.missing_fields,
    github: report.github || {},
    conflict_surface: report.conflict_surface || [],
  };
}

export async function recoverRegistryReport({ registryRoot, clock = () => new Date() } = {}) {
  const report = await recoverRegistry(registryRoot, { clock });
  return report;
}

export async function acquireLeaseReport({ registryRoot, runId, workspaceId, workspacePath = "", ttlMs, clock = () => new Date() } = {}) {
  const result = await acquireWorkspaceLease(registryRoot, runId, {
    workspaceId,
    workspacePath,
    ttlMs,
    clock,
  });
  return {
    schema_version: SCHEMA_VERSION,
    mode: "lease_acquire",
    registry_root: registryRoot,
    run_id: runId,
    status: result.status,
    state: result.run.state,
    lease: result.lease ? {
      lease_id: result.lease.lease_id,
      workspace_id: result.lease.workspace_id,
      workspace_path: result.lease.workspace_path,
      expires_at: result.lease.expires_at,
      lock_keys: result.lease.lock_keys,
    } : null,
    conflicts: result.conflicts,
    rolled_back_records: result.rolled_back_records,
    external_side_effects: false,
  };
}

export async function releaseLeaseReport({ registryRoot, runId, clock = () => new Date() } = {}) {
  const result = await releaseWorkspaceLease(registryRoot, runId, { clock });
  return {
    schema_version: SCHEMA_VERSION,
    mode: "lease_release",
    registry_root: registryRoot,
    run_id: runId,
    status: result.status,
    state: result.run.state,
    removed_lease_records: result.removed_lease_records.length,
    external_side_effects: false,
  };
}

export async function runLocalMissionReport({ registryRoot, runId, workspaceId = "", workspacePath = "", ttlMs = "", clock = () => new Date() } = {}) {
  return runLocalMission({ registryRoot, runId, workspaceId, workspacePath, ttlMs, clock });
}

export function formatBuranReport(report) {
  if (report.mode === "recovery") return withObservabilityLines(formatRecoveryReport(report), report);
  if (report.mode === "run_local") {
    const lines = [];
    lines.push("buran: run local");
    lines.push(`Registry: ${report.registry_root}`);
    lines.push(`Run: ${report.run_id}`);
    lines.push(`Outcome: ${report.outcome}`);
    lines.push(`State: ${report.previous_state || "<missing>"} -> ${report.current_state || "<missing>"}`);
    for (const step of report.steps_taken || []) {
      lines.push(`- ${step.action}: ${step.status} (${step.from_state || "<none>"} -> ${step.to_state || "<none>"})`);
    }
    if (report.workspace_preparation) {
      const preparation = report.workspace_preparation;
      if (preparation.artifact_ref?.path) {
        lines.push(`Workspace preparation: ${preparation.status}; artifact=${preparation.artifact_ref.path}`);
      } else if (preparation.blocker?.code) {
        lines.push(`Workspace preparation: ${preparation.status}; blocker=${preparation.blocker.code}`);
      }
    }
    if (report.blockers?.length) {
      for (const blocker of report.blockers) lines.push(`Blocker: ${blocker.code}: ${blocker.message}`);
    }
    if (report.warnings?.length) {
      for (const warning of report.warnings) lines.push(`Warning: ${warning.code}: ${warning.message}`);
    }
    lines.push("External side effects: no");
    return withObservabilityLines(lines.join("\n"), report);
  }
  if (report.mode === "lease_acquire") {
    const lines = [];
    lines.push("buran: lease acquire");
    lines.push(`Registry: ${report.registry_root}`);
    lines.push(`Run: ${report.run_id}; status=${report.status}; state=${report.state}`);
    if (report.lease) lines.push(`Workspace: ${report.lease.workspace_id} -> ${report.lease.workspace_path}; expires=${report.lease.expires_at}`);
    if (report.conflicts?.length) lines.push(`Conflicts: ${report.conflicts.length}`);
    lines.push("External side effects: no");
    return withObservabilityLines(lines.join("\n"), report);
  }
  if (report.mode === "lease_release") {
    return withObservabilityLines([
      "buran: lease release",
      `Registry: ${report.registry_root}`,
      `Run: ${report.run_id}; status=${report.status}; removed=${report.removed_lease_records}`,
      "External side effects: no",
    ].join("\n"), report);
  }
  const lines = [];
  lines.push(`buran: ${report.mode}`);
  lines.push(`Packets: ${report.summary.total}; sufficient=${report.summary.sufficient}; insufficient=${report.summary.insufficient}`);
  lines.push("Autonomous discovery: no");
  lines.push("Remote writes: no");
  lines.push("Task execution: no");
  if (report.registry_written) lines.push(`Registry: ${report.registry.root}`);
  for (const packet of report.packets) {
    const status = packet.sufficient ? "PASS" : `FAIL (${packet.missing_fields.join(", ")})`;
    lines.push(`- ${packet.task_id}: ${status}`);
  }
  return withObservabilityLines(lines.join("\n"), report);
}

function withObservabilityLines(text, report) {
  if (!report?.observability?.trace_id) return text;
  return [
    text,
    `Trace: ${report.observability.trace_id}`,
    `Log: ${report.observability.log_path}`,
    `Diagnostic report: ${report.observability.diagnostic_report_path}`,
  ].join("\n");
}
