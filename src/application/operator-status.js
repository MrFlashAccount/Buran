/**
 * Registry-backed read-only operator status projection for `/buran status`.
 *
 * The status surface is intentionally a query/read model: it reads durable run
 * snapshots, events, and safe artifact references through the registry port and
 * never repairs, transitions, recovers leases, dispatches workers, or calls remote
 * systems. Returned objects are public reports and must not include raw packet,
 * prompt, transcript, stdout/stderr, log, session, payload, or artifact content.
 */
import path from "node:path";

import { SCHEMA_VERSION, TERMINAL_STATES } from "../core/modules/execution-runs/constants.js";
import { deriveWorkerTaskSummary } from "../core/modules/execution-runs/entities/worker-task.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { isLeaseExpired, snapshotHasAcquiredLease, snapshotLeaseExpiresAt } from "../core/modules/workspace-leases/policy.js";
import { isRecord, nonEmptyString } from "../shared/primitives.js";

const STATUS_READ_METHODS = Object.freeze(["getRegistryPaths", "getRunPaths", "readRunSnapshot", "readEventsFile"]);
const BLOCKED_STATES = new Set(["blocked_plan_insufficient", "blocked_lock_conflict", "blocked_needs_human"]);
const FAILED_TERMINAL_STATES = new Set(["failed_execution"]);
const RAW_KEY_PATTERN = /(^|_)(prompt|transcript|stdout|stderr|output|raw|content|body|markdown|log|logs|session|payload)($|_)/i;
const SECRET_KEY_PATTERN = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|session)/i;
const SECRET_VALUE_PATTERN = /\b(gh[pousr]_|github_pat_|sk-|xox[baprs]-|Bearer\s+|token=|secret=|password=|api[_-]?key=)/i;
const FIX_LOOP_LIMIT = 2;

function issue(code, message, details = {}) {
  return Object.keys(details).length > 0 ? { code, message, details } : { code, message };
}

function safeText(value, { max = 240, allowPath = false } = {}) {
  const text = nonEmptyString(value);
  if (!text) return "";
  if (SECRET_VALUE_PATTERN.test(text)) return "";
  if (!allowPath && /(^|\s|["'=:(])\/(?!\/)[^\s"']+/.test(text)) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeRef(ref) {
  if (!isRecord(ref)) return null;
  const output = {};
  const pathText = safeArtifactPath(ref.path || ref.artifact_path || ref.ref || ref.file);
  if (pathText) output.path = pathText;
  const kind = safeText(ref.kind || ref.gate_name || ref.stage, { max: 80 });
  if (kind) output.kind = kind;
  const sha256 = safeText(ref.sha256 || ref.hash, { max: 128 });
  if (sha256) output.sha256 = sha256;
  const id = safeText(ref.id || ref.artifact_id, { max: 120 });
  if (id) output.id = id;
  const bytes = Number(ref.bytes || ref.size_bytes);
  if (Number.isSafeInteger(bytes) && bytes >= 0) output.bytes = bytes;
  const timestamp = safeText(ref.recorded_at || ref.created_at || ref.timestamp, { max: 80 });
  if (timestamp) output.recorded_at = timestamp;
  return Object.keys(output).length > 0 ? output : null;
}

function safeArtifactPath(value) {
  const text = nonEmptyString(value).replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.includes("..") || SECRET_VALUE_PATTERN.test(text)) return "";
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function sanitizeEvidence(value, depth = 0) {
  if (depth > 4) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return safeText(value, { max: 240, allowPath: false }) || "[REDACTED]";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeEvidence(entry, depth + 1));
  if (!isRecord(value)) return "[REDACTED]";
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (RAW_KEY_PATTERN.test(key)) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED_SECRET]";
      continue;
    }
    if (["path", "artifact_path", "ref", "file"].includes(key)) {
      const refPath = safeArtifactPath(entry);
      if (refPath) output[key] = refPath;
      continue;
    }
    output[key] = sanitizeEvidence(entry, depth + 1);
  }
  return output;
}

function baseReport({ registryRoot, runId }) {
  return {
    schema_version: SCHEMA_VERSION,
    mode: "status",
    registry_root: registryRoot,
    run_id: runId,
    task_id: "",
    status_kind: "missing",
    state: "missing",
    execution: { current_epoch: 0, stage: "missing", attempt: 0 },
    workspace: { workspace_id: "", lease_status: "missing", expires_at: "", stale_suspected: false },
    worker_task: { active: false, worker_task_id: "", status: "none", decision: "", overdue: false, artifact_refs: [] },
    artifacts: { last: [], key: {} },
    blockers: [],
    policy: { profile: "local-only", last_decision: null, summary: [] },
    audit: { last_event: null, external_writes: 0, approval_gated_actions: 0 },
    retry_budgets: [],
    next_safe_action: { kind: "check_run_id", command: null, reason: "run was not found in the local registry" },
    external_side_effects: false,
  };
}

function normalizeErrorKind(error) {
  if (error?.code === "ENOENT") return "missing";
  if (error instanceof SyntaxError) return "corrupt";
  const message = nonEmptyString(error?.message).toLowerCase();
  if (message.includes("quarantine")) return "quarantined";
  if (message.includes("json") || message.includes("schema") || message.includes("parse")) return "corrupt";
  return "corrupt";
}

function statusKindForSnapshot(snapshot) {
  if (snapshot?.quarantine || snapshot?.quarantined_at || snapshot?.state === "quarantined") return "quarantined";
  if (BLOCKED_STATES.has(snapshot?.state)) return "blocked";
  if (TERMINAL_STATES.has(snapshot?.state)) return "terminal";
  return "active";
}

function executionSummary(snapshot) {
  const gateName = snapshot?.state === "verification" || snapshot?.state === "internal_review" ? snapshot.state : "";
  const gate = gateName ? snapshot?.gates?.[gateName] : null;
  const worker = snapshot?.worker_tasks?.head;
  const currentEpoch = Number.isSafeInteger(snapshot?.execution?.current_epoch) ? snapshot.execution.current_epoch : 0;
  const gateAttempt = Number.isSafeInteger(gate?.current_attempt) ? gate.current_attempt : 0;
  const workerAttempt = Number.isSafeInteger(worker?.attempt) ? worker.attempt : 0;
  return {
    current_epoch: currentEpoch,
    stage: safeText(snapshot?.state, { max: 80 }) || "unknown",
    attempt: gateAttempt || workerAttempt || 0,
  };
}

function leaseStatus(snapshot, now) {
  const workspace = snapshot?.workspace || {};
  const locks = snapshot?.locks || {};
  const rawStatus = nonEmptyString(workspace.lease_status || locks.lease_status);
  const expiresAt = snapshotLeaseExpiresAt(snapshot);
  const acquired = snapshotHasAcquiredLease(snapshot);
  let lease_status = rawStatus || "missing";
  let stale_suspected = false;
  if (acquired && isLeaseExpired(expiresAt, now)) {
    lease_status = "expired";
    stale_suspected = !TERMINAL_STATES.has(snapshot?.state);
  } else if (!["missing", "acquired", "expired", "released", "unknown"].includes(lease_status)) {
    lease_status = lease_status.includes("stale") ? "stale_suspected" : "unknown";
    stale_suspected = lease_status === "stale_suspected";
  }
  return {
    workspace_id: safeText(workspace.id || workspace.workspace_id || locks.workspace_id, { max: 120 }) || "",
    lease_status,
    expires_at: safeText(expiresAt, { max: 80 }) || "",
    stale_suspected,
  };
}

function workerSummary(snapshot, now) {
  const summary = deriveWorkerTaskSummary(snapshot?.worker_tasks?.head || null, { now: now.toISOString() });
  return {
    active: Boolean(summary.active),
    worker_task_id: safeText(summary.worker_task_id, { max: 160 }) || "",
    purpose: safeText(summary.purpose, { max: 80 }) || undefined,
    role: safeText(summary.role, { max: 80 }) || undefined,
    status: safeText(summary.status, { max: 80 }) || "none",
    decision: safeText(summary.decision, { max: 80 }) || "",
    overdue: Boolean(summary.overdue),
    deadline_at: summary.deadline_at || null,
    artifact_refs: [safeRef(summary.dispatch_ref), safeRef(summary.completion_ref)].filter(Boolean),
  };
}

function collectArtifactRefs(snapshot, events) {
  const refs = [];
  const key = {};
  const add = (candidate, keyName = "") => {
    const ref = safeRef(candidate);
    if (!ref) return;
    refs.push(ref);
    if (keyName && !key[keyName]) key[keyName] = ref;
  };
  for (const [name, value] of Object.entries(isRecord(snapshot?.artifacts) ? snapshot.artifacts : {})) {
    if (name === "recorded" && isRecord(value?.by_path)) {
      for (const summary of Object.values(value.by_path)) add(summary, safeText(summary?.gate_name || summary?.provenance?.kind, { max: 80 }));
      continue;
    }
    add(value, name);
  }
  for (const gateName of ["verification", "internal_review"]) {
    const gate = snapshot?.gates?.[gateName];
    for (const ref of Array.isArray(gate?.artifact_refs) ? gate.artifact_refs : []) add(ref, gateName);
  }
  for (const event of events.slice(-50)) {
    if (event?.type === "artifact.recorded") add(event.evidence, safeText(event.evidence?.gate_name || event.evidence?.stage, { max: 80 }));
    if (event?.evidence?.artifact_ref) add(event.evidence.artifact_ref, safeText(event.type, { max: 80 }));
  }
  const unique = [];
  const seen = new Set();
  for (const ref of refs) {
    const identity = `${ref.path || ""}:${ref.sha256 || ""}:${ref.id || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(ref);
  }
  return { last: unique.slice(-10), key };
}

function policySummary(events) {
  const policyEvents = events.filter((event) => event?.type === "policy.decision_recorded");
  const counts = new Map();
  for (const event of policyEvents) {
    const decision = safeText(event?.evidence?.decision, { max: 80 }) || "unknown";
    counts.set(decision, (counts.get(decision) || 0) + 1);
  }
  const last = policyEvents.at(-1);
  return {
    profile: safeText(last?.evidence?.policy_profile, { max: 80 }) || "local-only",
    last_decision: last ? {
      action_kind: safeText(last.evidence?.action_kind, { max: 120 }) || "unknown",
      decision: safeText(last.evidence?.decision, { max: 80 }) || "unknown",
      target: sanitizeEvidence(last.evidence?.target || null),
      timestamp: safeText(last.timestamp, { max: 80 }) || "",
    } : null,
    summary: Array.from(counts.entries()).map(([decision, count]) => ({ decision, count })),
  };
}

function auditSummary(events) {
  const auditEvents = events.filter((event) => event?.type === "audit.action_recorded");
  const last = auditEvents.at(-1);
  return {
    last_event: last ? {
      action_kind: safeText(last.evidence?.action_kind, { max: 120 }) || "unknown",
      result: safeText(last.evidence?.result, { max: 80 }) || "",
      external_side_effects: Boolean(last.evidence?.external_side_effects),
      timestamp: safeText(last.timestamp, { max: 80 }) || "",
    } : null,
    external_writes: auditEvents.filter((event) => event?.evidence?.external_side_effects).length,
    approval_gated_actions: auditEvents.filter((event) => event?.evidence?.approval_required || event?.evidence?.decision === "approval_required").length,
  };
}

function retryBudgets(snapshot, events) {
  const configured = Array.isArray(snapshot?.retry_budgets) ? snapshot.retry_budgets : [];
  const fromSnapshot = configured.map((budget) => normalizeBudget(budget)).filter(Boolean);
  const fixLoop = fixLoopBudget(snapshot, events);
  return [...fromSnapshot, ...(fixLoop ? [fixLoop] : [])];
}

function normalizeBudget(budget) {
  if (!isRecord(budget)) return null;
  const limit = Number(budget.limit);
  const used = Number(budget.used);
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(used) || used < 0) return null;
  return {
    name: safeText(budget.name, { max: 80 }) || "unknown",
    scope: safeText(budget.scope, { max: 80 }) || "run",
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted: used >= limit,
    last_event: safeText(budget.last_event, { max: 120 }) || "",
    blocker_code: safeText(budget.blocker_code, { max: 120 }) || (used >= limit ? "retry_budget_exhausted" : ""),
  };
}

function fixLoopBudget(snapshot, events) {
  const recorded = Object.values(snapshot?.artifacts?.recorded?.by_path || {})
    .filter((summary) => summary?.gate_name === "fix_attempt" && summary?.provenance?.kind === "fix-attempt-result").length;
  const eventAttempts = events.filter((event) => event?.type === "worker_task.created" && event?.evidence?.purpose === "fix_attempt").length;
  const used = Math.max(recorded, eventAttempts);
  if (used <= 0 && snapshot?.state !== "fix_loop") return null;
  return {
    name: "fix_loop",
    scope: "execution_epoch",
    used,
    limit: FIX_LOOP_LIMIT,
    remaining: Math.max(0, FIX_LOOP_LIMIT - used),
    exhausted: used >= FIX_LOOP_LIMIT,
    last_event: events.filter((event) => event?.type?.startsWith?.("worker_task.")).at(-1)?.type || "",
    blocker_code: used >= FIX_LOOP_LIMIT ? "retry_budget_exhausted" : "",
  };
}

function nextSafeAction(report) {
  if (report.status_kind === "missing") return { kind: "check_run_id", command: null, reason: "run was not found in the local registry" };
  if (report.status_kind === "corrupt") return { kind: "recover", command: `/buran recover --registry ${report.registry_root}`, reason: "run registry data could not be parsed safely" };
  if (report.status_kind === "quarantined") return { kind: "inspect_quarantine", command: null, reason: "run is quarantined and requires manual inspection" };
  const exhausted = report.retry_budgets.find((budget) => budget.exhausted);
  if (exhausted) return { kind: "manual_review", command: null, reason: `retry budget exhausted: ${exhausted.name}` };
  if (report.workspace.stale_suspected || report.workspace.lease_status === "expired" || report.workspace.lease_status === "stale_suspected") {
    return { kind: "recover", command: `/buran recover --registry ${report.registry_root}`, reason: "lease is expired or stale-suspected; status will not reclaim it" };
  }
  if (report.status_kind === "blocked") {
    return report.state === "blocked_lock_conflict"
      ? { kind: "manual_review", command: null, reason: "lock conflict needs operator decision or waiting" }
      : { kind: "manual_review", command: null, reason: "run is blocked and needs human review" };
  }
  if (report.state === "queued") return { kind: "run", command: `/buran run --run ${report.run_id} --registry ${report.registry_root}`, reason: "run is queued and ready for the local runner" };
  if (report.state === "waiting_for_lock") {
    return report.workspace.lease_status === "acquired"
      ? { kind: "run", command: `/buran run --run ${report.run_id} --registry ${report.registry_root}`, reason: "workspace lease is already acquired" }
      : { kind: "lease_acquire", command: null, reason: "run is waiting for a workspace lease" };
  }
  if (report.state === "running" && report.worker_task.active) return { kind: report.worker_task.overdue ? "recover" : "wait", command: report.worker_task.overdue ? `/buran recover --registry ${report.registry_root}` : null, reason: report.worker_task.overdue ? "worker task is overdue" : "implementation worker task is still pending" };
  if (["running", "verification", "internal_review", "fix_loop", "handoff_ready"].includes(report.state)) return { kind: "run", command: `/buran run --run ${report.run_id} --registry ${report.registry_root}`, reason: "run has a pending local runner gate" };
  if (report.state === "ready_for_manual_review") return { kind: "manual_review", command: null, reason: "run is ready for manual review" };
  if (FAILED_TERMINAL_STATES.has(report.state)) return { kind: "manual_review", command: null, reason: "run failed and needs operator review" };
  if (report.status_kind === "terminal") return { kind: "none", command: null, reason: "run is terminal" };
  return { kind: "manual_review", command: null, reason: "operator review recommended for current run state" };
}

function addDerivedBlockers(report) {
  if (report.status_kind === "blocked") report.blockers.push(issue(report.state, `Run is blocked in state ${report.state}.`));
  if (report.worker_task.overdue) report.blockers.push(issue("worker_task_overdue", "Worker task deadline has passed; status did not recover or mutate the run."));
  for (const budget of report.retry_budgets) {
    if (budget.exhausted) report.blockers.push(issue(budget.blocker_code || "retry_budget_exhausted", `Retry budget ${budget.name} is exhausted.`, { budget }));
  }
}

function markProblemReport({ registryRoot, runId, kind, error }) {
  const report = baseReport({ registryRoot, runId });
  report.status_kind = kind;
  report.state = kind;
  const code = kind === "missing" ? "run_not_found" : kind === "quarantined" ? "run_quarantined" : "run_corrupt";
  const message = kind === "missing"
    ? `Run ${runId} was not found in the local registry.`
    : kind === "quarantined"
      ? `Run ${runId} is quarantined and requires manual inspection.`
      : `Run ${runId} could not be read safely from the local registry.`;
  report.blockers = [issue(code, message, { error_kind: normalizeErrorKind(error) })];
  report.next_safe_action = nextSafeAction(report);
  return report;
}

/**
 * Build a read-only public status report from durable registry truth.
 *
 * @param {{registryRoot: string, runId: string, registryRepository: object, clock?: () => Date}} input
 * @returns {Promise<object>} Public operator status report.
 */
export async function buildOperatorStatusReport({ registryRoot, runId, registryRepository, clock = () => new Date() } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for status");
  if (!runId) throw new Error("runId is required for status");
  const registry = assertRegistryRepository(registryRepository, { methodNames: STATUS_READ_METHODS });
  const paths = registry.getRunPaths(registryRoot, runId);
  let snapshot;
  try {
    snapshot = await registry.readRunSnapshot(paths.runPath);
  } catch (error) {
    return markProblemReport({ registryRoot, runId, kind: normalizeErrorKind(error), error });
  }

  let events = [];
  try {
    events = await registry.readEventsFile(paths.eventsPath);
  } catch (error) {
    if (error?.code !== "ENOENT") return markProblemReport({ registryRoot, runId, kind: normalizeErrorKind(error), error });
  }

  const now = clock();
  const report = baseReport({ registryRoot, runId });
  report.task_id = safeText(snapshot.task_id, { max: 160 }) || "";
  report.status_kind = statusKindForSnapshot(snapshot);
  report.state = safeText(snapshot.state, { max: 80 }) || "unknown";
  report.execution = executionSummary(snapshot);
  report.workspace = leaseStatus(snapshot, now);
  report.worker_task = workerSummary(snapshot, now);
  report.artifacts = collectArtifactRefs(snapshot, events);
  report.policy = policySummary(events);
  report.audit = auditSummary(events);
  report.retry_budgets = retryBudgets(snapshot, events);
  if (report.status_kind === "quarantined") report.blockers.push(issue("run_quarantined", "Run is quarantined and requires manual inspection."));
  addDerivedBlockers(report);
  report.next_safe_action = nextSafeAction(report);

  // Keep the repository path method exercised as part of the read-only contract
  // without depending on concrete storage internals.
  const registryPaths = registry.getRegistryPaths(registryRoot);
  if (registryPaths?.quarantine && report.status_kind === "quarantined") {
    report.quarantine = { basename: path.basename(registryPaths.quarantine) };
  }
  return report;
}
