import { promises as fs } from "node:fs";
import path from "node:path";

import { PLUGIN_ID, SCHEMA_VERSION } from "../core/modules/execution-runs/constants.js";
import { assertWorkspaceLeaseService } from "../core/modules/workspace-leases/ports/workspace-lease-service.js";
import { normalizePacketList, summarizePacketReports } from "../approved-packets/sufficiency.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { formatRecoveryReport, recoverRegistry } from "../execution-runs/recovery/index.js";
import { runLocalMission } from "./run-local-mission.js";
import { buildOperatorStatusReport } from "./operator-status.js";
import { nonEmptyString, resolveMaybeRelative } from "../shared/primitives.js";

function configuredImplementationDispatchAdapter(config) {
  const candidates = [
    config.implementationDispatchAdapter,
    config.implementation_dispatch_adapter,
    config.implementationDispatch?.adapter,
    config.implementation_dispatch?.adapter,
    config.devHarness?.implementationDispatchAdapter,
    config.devHarness?.dispatchAdapter,
    config.dev_harness?.implementation_dispatch_adapter,
    config.dev_harness?.dispatch_adapter,
  ];
  return candidates.find((candidate) => candidate && typeof candidate.execute === "function") || null;
}

function configuredScmHandoffAdapter(config) {
  const candidates = [
    config.scmHandoffAdapter,
    config.scm_handoff_adapter,
    config.scmHandoff?.adapter,
    config.scm_handoff?.adapter,
  ];
  return candidates.find((candidate) => candidate && typeof candidate.plan === "function" && typeof candidate.execute === "function") || null;
}

export function normalizeBuranConfig(raw = {}, { workspaceDir = process.cwd(), stateDir = "" } = {}) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const configuredRoot = nonEmptyString(config.registryRoot);
  const defaultRoot = stateDir
    ? path.join(stateDir, "plugins", PLUGIN_ID, "registry")
    : path.join(workspaceDir, ".openclaw-runtime", "plugins", PLUGIN_ID, "registry");
  return {
    registryRoot: configuredRoot ? resolveMaybeRelative(workspaceDir, configuredRoot) : defaultRoot,
    implementationDispatchAdapter: configuredImplementationDispatchAdapter(config),
    scmHandoffAdapter: configuredScmHandoffAdapter(config),
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

export async function intakePacketListFile(packetListPath, { registryRoot, registryRepository, clock = () => new Date() } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for intake");
  const registry = assertRegistryRepository(registryRepository);
  const parsed = await readPacketListFile(packetListPath);
  const reports = normalizePacketList(parsed, { sourcePath: packetListPath });
  const runs = [];
  const createdAt = clock().toISOString();
  const intakeClock = () => new Date(createdAt);

  for (const report of reports) {
    const created = await registry.createRunFromPacketReport(report, { registryRoot, clock: intakeClock });
    runs.push({
      run_id: created.run.run_id,
      task_id: created.run.task_id,
      state: created.run.state,
      run_dir: created.run_dir,
      missing_fields: created.run.packet.missing_fields,
    });
  }
  const batch = await registry.createBatchFromPacketReports(reports, runs, {
    registryRoot,
    createdAt,
  });

  return {
    schema_version: SCHEMA_VERSION,
    mode: "intake",
    registry_written: true,
    registry: registry.getRegistryPaths(registryRoot),
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
    scm_target: report.scm_target || {},
    conflict_surface: report.conflict_surface || [],
  };
}

export async function recoverRegistryReport({ registryRoot, registryRepository, workspaceLeaseService, registryRecoveryStore, clock = () => new Date() } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const report = await recoverRegistry(registryRoot, { clock, registryRepository: registry, workspaceLeaseService, registryRecoveryStore });
  return report;
}

export async function acquireLeaseReport({ registryRoot, runId, workspaceId, workspacePath = "", ttlMs, workspaceLeaseService, clock = () => new Date() } = {}) {
  const leases = assertWorkspaceLeaseService(workspaceLeaseService);
  const result = await leases.acquire(registryRoot, runId, {
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

export async function releaseLeaseReport({ registryRoot, runId, workspaceLeaseService, clock = () => new Date() } = {}) {
  const leases = assertWorkspaceLeaseService(workspaceLeaseService);
  const result = await leases.release(registryRoot, runId, { clock });
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

export async function runLocalMissionReport({ registryRoot, runId, workspaceId = "", workspacePath = "", ttlMs = "", clock = () => new Date(), implementationDispatchAdapter = null, scmHandoffAdapter = null, registryRepository, workspaceLeaseService, workspacePreparationInspector, stackPrerequisite = null } = {}) {
  return runLocalMission({
    registryRoot,
    registryRepository,
    workspaceLeaseService,
    workspacePreparationInspector,
    runId,
    workspaceId,
    workspacePath,
    ttlMs,
    clock,
    ...(implementationDispatchAdapter ? { implementationDispatchAdapter } : {}),
    ...(scmHandoffAdapter ? { scmHandoffAdapter } : {}),
    ...(stackPrerequisite ? { stackPrerequisite } : {}),
  });
}

export async function statusRunReport({ registryRoot, runId, registryRepository, clock = () => new Date() } = {}) {
  return buildOperatorStatusReport({ registryRoot, runId, registryRepository, clock });
}

export function formatBuranReport(report) {
  if (report.mode === "recovery") return withObservabilityLines(formatRecoveryReport(report), report);
  if (report.mode === "status") return withObservabilityLines(formatStatusReport(report), report);
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
    if (report.implementation_dispatch) {
      const dispatch = report.implementation_dispatch;
      if (dispatch.result_artifact_ref?.path) {
        lines.push(`Implementation dispatch: ${dispatch.status}; result=${dispatch.result_artifact_ref.path}`);
      } else if (dispatch.intent_artifact_ref?.path) {
        lines.push(`Implementation dispatch: ${dispatch.status}; intent=${dispatch.intent_artifact_ref.path}`);
      } else if (dispatch.problem?.code) {
        lines.push(`Implementation dispatch: ${dispatch.status}; problem=${dispatch.problem.code}`);
      }
    }
    if (report.verification) {
      const verification = report.verification;
      if (verification.artifact_ref?.path) {
        lines.push(`Verification: ${verification.status}; artifact=${verification.artifact_ref.path}`);
      } else if (verification.artifact_refs?.[0]?.path) {
        lines.push(`Verification: ${verification.status}; artifact=${verification.artifact_refs[0].path}`);
      } else if (verification.problem?.code) {
        lines.push(`Verification: ${verification.status}; blocker=${verification.problem.code}`);
      }
    }
    if (report.internal_review) {
      const internalReview = report.internal_review;
      if (internalReview.artifact_ref?.path) {
        lines.push(`Internal review: ${internalReview.status}; artifact=${internalReview.artifact_ref.path}`);
      } else if (internalReview.artifact_refs?.[0]?.path) {
        lines.push(`Internal review: ${internalReview.status}; artifact=${internalReview.artifact_refs[0].path}`);
      } else if (internalReview.problem?.code) {
        lines.push(`Internal review: ${internalReview.status}; blocker=${internalReview.problem.code}`);
      }
    }
    if (report.projection) {
      const projection = report.projection;
      if (projection.result_artifact_ref?.path) {
        lines.push(`SCM handoff: ${projection.status}; artifact=${projection.result_artifact_ref.path}`);
      } else if (projection.problem?.code) {
        lines.push(`SCM handoff: ${projection.status}; blocker=${projection.problem.code}`);
      }
    }
    if (report.blockers?.length) {
      for (const blocker of report.blockers) lines.push(`Blocker: ${blocker.code}: ${blocker.message}`);
    }
    if (report.warnings?.length) {
      for (const warning of report.warnings) lines.push(`Warning: ${warning.code}: ${warning.message}`);
    }
    lines.push(`External side effects: ${report.external_side_effects ? "yes" : "no"}`);
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

function formatStatusReport(report) {
  const lines = [];
  lines.push("buran: status");
  lines.push(`Registry: ${report.registry_root}`);
  lines.push(`Run: ${report.run_id}${report.task_id ? `; task=${report.task_id}` : ""}`);
  lines.push(`State: ${report.state} (${report.status_kind})`);
  if (report.execution) lines.push(`Execution: epoch=${report.execution.current_epoch} stage=${report.execution.stage} attempt=${report.execution.attempt}`);
  if (report.workspace) {
    const workspaceId = report.workspace.workspace_id || "<none>";
    const expires = report.workspace.expires_at ? ` expires=${report.workspace.expires_at}` : "";
    const stale = report.workspace.stale_suspected ? " stale_suspected=yes" : "";
    lines.push(`Workspace: ${workspaceId} lease=${report.workspace.lease_status}${expires}${stale}`);
  }
  if (report.worker_task?.worker_task_id) {
    lines.push(`Worker task: ${report.worker_task.worker_task_id} ${report.worker_task.role || ""} ${report.worker_task.status}${report.worker_task.overdue ? " overdue" : ""}`.trim());
  }
  if (report.artifacts?.last?.length) lines.push(`Artifacts: ${report.artifacts.last.map((artifact) => artifact.path || artifact.id || artifact.kind).filter(Boolean).join(", ")}`);
  if (report.blockers?.length) {
    for (const blocker of report.blockers) lines.push(`Blocker: ${blocker.code}: ${blocker.message}`);
  }
  const policyLast = report.policy?.last_decision ? `${report.policy.last_decision.action_kind}:${report.policy.last_decision.decision}` : "none";
  lines.push(`Policy: ${report.policy?.profile || "local-only"}; last=${policyLast}`);
  lines.push(`Audit: external_writes=${report.audit?.external_writes || 0} approval_gated_actions=${report.audit?.approval_gated_actions || 0}`);
  const exhausted = (report.retry_budgets || []).filter((budget) => budget.exhausted).map((budget) => budget.name);
  if (exhausted.length) lines.push(`Retry exhausted: ${exhausted.join(", ")}`);
  if (report.next_safe_action) {
    lines.push(`Next safe action: ${report.next_safe_action.kind} — ${report.next_safe_action.reason}`);
    if (report.next_safe_action.command) lines.push(`Command: ${report.next_safe_action.command}`);
  }
  lines.push(`External side effects: ${report.external_side_effects ? "yes" : "no"}`);
  return lines.join("\n");
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
