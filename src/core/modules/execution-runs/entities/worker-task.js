import {
  WORKER_COMPLETION_DECISIONS,
  WORKER_TASK_ROLE_BY_PURPOSE,
  WORKER_TASK_ROLE_SET,
  WORKER_TASK_STATUSES,
} from "../constants.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../../../../shared/primitives.js";

const STATUS_SET = new Set(WORKER_TASK_STATUSES);
const DECISION_SET = new Set(WORKER_COMPLETION_DECISIONS);
const RAW_KEY_PATTERN = /(^|_)(prompt|transcript|stdout|stderr|output|raw|content|body|markdown|log|logs|session|payload)($|_)/i;
const SAFE_REF_KEYS = new Set(["path", "sha256", "id", "kind"]);
const TERMINAL_WORKER_TASK_STATUSES = new Set(["completed", "failed", "quarantined"]);

function positiveOrZero(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function unsafePublicText(value) {
  const text = nonEmptyString(value);
  return /(^|\s|["'=:])\/(?!\/)[^\s"']+/.test(text)
    || /(^|\s|["'=:])[A-Za-z]:\\\\/.test(text)
    || /(authorization|api[_-]?key|token|secret|password|credential)\s*[=:]/i.test(text)
    || /\b(ghp|github_pat|sk|xox[baprs])-[-_A-Za-z0-9]{8,}\b/i.test(text);
}

function safeText(value, max = 160) {
  const text = nonEmptyString(value);
  if (unsafePublicText(text)) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeRefs(refs) {
  const entries = Array.isArray(refs) ? refs : isRecord(refs) ? [refs] : [];
  return entries.map((ref) => {
    if (!isRecord(ref)) return null;
    const output = {};
    for (const [key, value] of Object.entries(ref)) {
      if (!SAFE_REF_KEYS.has(key)) continue;
      const text = safeText(value, key === "sha256" ? 128 : 240);
      if (text) output[key] = text;
    }
    return Object.keys(output).length > 0 ? output : null;
  }).filter(Boolean).slice(0, 20);
}

function normalizePurpose(value) {
  const purpose = nonEmptyString(value);
  return ["implementation_dispatch", "fix_attempt"].includes(purpose) ? purpose : "implementation_dispatch";
}

export function normalizeRole(value, { purpose = "" } = {}) {
  const role = nonEmptyString(value);
  if (WORKER_TASK_ROLE_SET.has(role)) return role;
  return WORKER_TASK_ROLE_BY_PURPOSE[normalizePurpose(purpose)] || "implementer";
}

function normalizeAuthority(value) {
  return safeText(value, 120) || "implementation-harness-dispatch.v1";
}

export function deriveWorkerTaskRole(purpose) {
  return WORKER_TASK_ROLE_BY_PURPOSE[normalizePurpose(purpose)] || "implementer";
}

function normalizeTimestamp(value) {
  const timestamp = nonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : new Date(0).toISOString();
}

function normalizeStatus(value, fallback = "created") {
  const status = nonEmptyString(value);
  return STATUS_SET.has(status) ? status : fallback;
}

function normalizeDecision(value, fallback = "deferred") {
  const decision = nonEmptyString(value);
  return DECISION_SET.has(decision) ? decision : fallback;
}

function sanitizeCompletionEvidence(completion = {}) {
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(isRecord(completion.evidence) ? completion.evidence : {})) {
    const key = nonEmptyString(rawKey).toLowerCase();
    if (!key || RAW_KEY_PATTERN.test(key)) continue;
    if (["files_changed", "changed_files"].includes(key)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const sanitized = values.map((entry) => safeText(entry, 240)).filter(Boolean).slice(0, 50);
      if (sanitized.length > 0) output[key] = sanitized;
      continue;
    }
    if (["artifact_ref", "result_artifact_ref", "implementation_artifact_ref"].includes(key)) {
      const sanitized = sanitizeRefs(rawValue)[0];
      if (sanitized) output[key] = sanitized;
      continue;
    }
    if (["artifact_refs", "result_artifact_refs", "implementation_artifact_refs"].includes(key)) {
      const sanitized = sanitizeRefs(rawValue);
      if (sanitized.length > 0) output[key] = sanitized;
      continue;
    }
    if (["implementation_result_id", "commit_sha", "patch_sha", "branch", "status"].includes(key)) {
      const sanitized = safeText(rawValue, 240);
      if (sanitized) output[key] = sanitized;
    }
  }
  return output;
}

function taskIdentity(input = {}) {
  return {
    run_id: nonEmptyString(input.run_id),
    task_id: nonEmptyString(input.task_id),
    purpose: normalizePurpose(input.purpose),
    role: normalizeRole(input.role, { purpose: input.purpose }),
    epoch: positiveOrZero(input.epoch),
    attempt: positiveOrZero(input.attempt || 1) || 1,
    authority: normalizeAuthority(input.authority),
  };
}

export function buildWorkerTaskId(input = {}) {
  const identity = taskIdentity(input);
  const hash = sha256Hex(canonicalJson(identity)).slice(0, 16);
  return `wt_${identity.run_id || "run"}_${identity.purpose}_${identity.epoch}_${identity.attempt}_${hash}`;
}

export class WorkerTask {
  constructor(snapshot = {}) {
    if (!isRecord(snapshot)) throw new Error("WorkerTask snapshot must be an object");
    this.snapshot = workerTaskFromSnapshot(snapshot);
  }

  get id() { return this.snapshot.worker_task_id; }
  get status() { return this.snapshot.status; }
  get purpose() { return this.snapshot.purpose; }
  get role() { return this.snapshot.role; }
  get epoch() { return this.snapshot.epoch; }
  get attempt() { return this.snapshot.attempt; }
  hasStatus(status) { return this.status === status; }
  isActive() { return ["created", "dispatched", "completion_received"].includes(this.status); }
  toSnapshot() { return this.snapshot; }
}

export function workerTaskFromSnapshot(snapshot = {}) {
  if (!isRecord(snapshot)) throw new Error("WorkerTask snapshot must be an object");
  const identity = taskIdentity({
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    purpose: snapshot.purpose,
    role: snapshot.role,
    epoch: snapshot.epoch,
    attempt: snapshot.attempt,
    authority: snapshot.authority,
  });
  return {
    worker_task_id: nonEmptyString(snapshot.worker_task_id) || buildWorkerTaskId(identity),
    ...identity,
    status: normalizeStatus(snapshot.status),
    deadline_at: snapshot.deadline_at === null ? null : nonEmptyString(snapshot.deadline_at),
    created_at: normalizeTimestamp(snapshot.created_at),
    updated_at: normalizeTimestamp(snapshot.updated_at || snapshot.created_at),
    dispatch: isRecord(snapshot.dispatch) ? cloneJson(snapshot.dispatch) : null,
    completion: isRecord(snapshot.completion) ? cloneJson(snapshot.completion) : null,
    decision: isRecord(snapshot.decision) ? cloneJson(snapshot.decision) : null,
    overdue_recorded_at: nonEmptyString(snapshot.overdue_recorded_at),
    quarantine: isRecord(snapshot.quarantine) ? cloneJson(snapshot.quarantine) : null,
  };
}

export function createWorkerTask(input = {}) {
  const identity = taskIdentity(input);
  const timestamp = normalizeTimestamp(input.created_at || input.recorded_at || new Date().toISOString());
  const worker_task_id = nonEmptyString(input.worker_task_id) || buildWorkerTaskId(identity);
  return workerTaskFromSnapshot({
    ...identity,
    worker_task_id,
    status: "created",
    deadline_at: input.deadline_at ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

export function recordWorkerTaskDispatch(head, dispatch = {}) {
  const task = workerTaskFromSnapshot(head);
  if (!["created", "dispatched"].includes(task.status)) throw new Error(`cannot record dispatch for worker task in status ${task.status}`);
  const recordedAt = normalizeTimestamp(dispatch.recorded_at || dispatch.dispatched_at || new Date().toISOString());
  return workerTaskFromSnapshot({
    ...task,
    status: "dispatched",
    updated_at: recordedAt,
    dispatch: {
      intent_ref: isRecord(dispatch.intent_ref) ? cloneJson(dispatch.intent_ref) : null,
      dispatch_ref: isRecord(dispatch.dispatch_ref) ? cloneJson(dispatch.dispatch_ref) : null,
      idempotency_key: nonEmptyString(dispatch.idempotency_key),
      recorded_at: recordedAt,
    },
  });
}

export function normalizeWorkerCompletion(completion = {}) {
  return {
    worker_task_id: nonEmptyString(completion.worker_task_id),
    run_id: nonEmptyString(completion.run_id),
    task_id: nonEmptyString(completion.task_id),
    purpose: normalizePurpose(completion.purpose),
    role: normalizeRole(completion.role, { purpose: completion.purpose }),
    epoch: positiveOrZero(completion.epoch),
    attempt: positiveOrZero(completion.attempt || 1) || 1,
    authority: normalizeAuthority(completion.authority),
    status: nonEmptyString(completion.status).toUpperCase() || "BLOCKED",
    completion_ref: isRecord(completion.completion_ref) ? cloneJson(completion.completion_ref) : null,
    evidence: sanitizeCompletionEvidence(completion),
    idempotency_key: nonEmptyString(completion.idempotency_key),
    received_at: normalizeTimestamp(completion.received_at || completion.recorded_at || new Date().toISOString()),
  };
}

function hasDurableCompletionRef(ref) {
  return isRecord(ref) && (
    (nonEmptyString(ref.path) && nonEmptyString(ref.sha256))
    || nonEmptyString(ref.id)
    || nonEmptyString(ref.sha256)
  );
}

function sameDurableCompletionIdentity(left, right) {
  const leftKey = nonEmptyString(left?.idempotency_key);
  const rightKey = nonEmptyString(right?.idempotency_key);
  if (leftKey && rightKey && leftKey === rightKey) return true;
  if (hasDurableCompletionRef(left?.completion_ref) && hasDurableCompletionRef(right?.completion_ref)) {
    return canonicalJson(left.completion_ref) === canonicalJson(right.completion_ref);
  }
  return false;
}

export function completionDecisionMutatesCurrentTruth(decision) {
  return ["accepted", "deferred"].includes(normalizeDecision(decision));
}

export function evaluateWorkerCompletion(head, completion = {}, { now = new Date().toISOString() } = {}) {
  if (!isRecord(head)) {
    return { decision: "unknown", reason: "no active worker task", decided_at: normalizeTimestamp(now) };
  }
  const task = workerTaskFromSnapshot(head);
  const normalized = normalizeWorkerCompletion(completion);
  const decidedAt = normalizeTimestamp(now);
  const accepted = isRecord(task.decision) && task.decision.decision === "accepted";

  if (normalized.worker_task_id && normalized.worker_task_id !== task.worker_task_id) {
    return { decision: "late", reason: "completion references a different worker task", decided_at: decidedAt };
  }
  if (!normalized.worker_task_id) return { decision: "unknown", reason: "completion is missing worker_task_id", decided_at: decidedAt };
  if (normalized.run_id !== task.run_id || normalized.task_id !== task.task_id) {
    return { decision: "unknown", reason: "completion run/task identity does not match", decided_at: decidedAt };
  }
  if (normalized.authority !== task.authority) {
    return { decision: "unauthorized", reason: "completion authority does not match worker task", decided_at: decidedAt };
  }
  if (normalized.epoch !== task.epoch || normalized.attempt !== task.attempt || normalized.purpose !== task.purpose || normalized.role !== task.role) {
    return { decision: "late", reason: "completion epoch/attempt/purpose/role is not current", decided_at: decidedAt };
  }
  if (accepted) {
    return sameDurableCompletionIdentity(task.completion, normalized)
      ? { decision: "duplicate", reason: "completion already accepted", decided_at: decidedAt }
      : { decision: "conflict", reason: "accepted completion already exists", decided_at: decidedAt };
  }
  if (!["created", "dispatched", "completion_received"].includes(task.status)) {
    return { decision: "late", reason: `worker task is already ${task.status}`, decided_at: decidedAt };
  }
  if (!["COMPLETED", "FAILED"].includes(normalized.status)) {
    return { decision: "deferred", reason: "completion did not provide terminal worker status", decided_at: decidedAt };
  }
  return { decision: "accepted", reason: "completion matches current worker task", decided_at: decidedAt };
}

export function applyCompletionDecisionToWorkerTask(head, completion = {}, decision = {}) {
  const task = workerTaskFromSnapshot(head);
  const normalizedCompletion = normalizeWorkerCompletion(completion);
  const normalizedDecision = {
    decision: normalizeDecision(decision.decision),
    reason: safeText(decision.reason, 240) || "completion decision recorded",
    decided_at: normalizeTimestamp(decision.decided_at || new Date().toISOString()),
    idempotency_key: nonEmptyString(decision.idempotency_key) || normalizedCompletion.idempotency_key,
  };
  if (!completionDecisionMutatesCurrentTruth(normalizedDecision.decision)) return task;
  const evaluated = evaluateWorkerCompletion(task, normalizedCompletion, { now: normalizedDecision.decided_at });
  if (evaluated.decision !== normalizedDecision.decision) return task;
  const statusByDecision = {
    accepted: normalizedCompletion.status === "FAILED" ? "failed" : "completed",
    deferred: "completion_received",
  };
  return workerTaskFromSnapshot({
    ...task,
    status: statusByDecision[normalizedDecision.decision] || task.status,
    updated_at: normalizedDecision.decided_at,
    completion: normalizedCompletion,
    decision: normalizedDecision,
  });
}

export function markWorkerTaskOverdue(head, { recorded_at = new Date().toISOString(), reason = "worker task deadline passed" } = {}) {
  const task = workerTaskFromSnapshot(head);
  if (TERMINAL_WORKER_TASK_STATUSES.has(task.status)) return task;
  return workerTaskFromSnapshot({
    ...task,
    status: "overdue",
    updated_at: normalizeTimestamp(recorded_at),
    overdue_recorded_at: normalizeTimestamp(recorded_at),
    decision: task.decision || { decision: "deferred", reason: safeText(reason), decided_at: normalizeTimestamp(recorded_at), idempotency_key: "" },
  });
}

export function quarantineWorkerTask(head, { recorded_at = new Date().toISOString(), reason = "worker task requires human review", details = {} } = {}) {
  const task = workerTaskFromSnapshot(head);
  return workerTaskFromSnapshot({
    ...task,
    status: "quarantined",
    updated_at: normalizeTimestamp(recorded_at),
    quarantine: { reason: safeText(reason, 240), details: isRecord(details) ? cloneJson(details) : {}, recorded_at: normalizeTimestamp(recorded_at) },
  });
}

export function deriveWorkerTaskSummary(head, { now = new Date().toISOString() } = {}) {
  if (!isRecord(head)) {
    return { active: false, worker_task_id: "", status: "none", decision: "", overdue: false, next_safe_action: "no active worker task" };
  }
  const task = workerTaskFromSnapshot(head);
  const overdue = Boolean(task.deadline_at && Date.parse(task.deadline_at) < Date.parse(now) && !TERMINAL_WORKER_TASK_STATUSES.has(task.status) && !["duplicate", "late", "rejected"].includes(task.status));
  const decision = nonEmptyString(task.decision?.decision);
  const nextSafeAction = task.status === "conflict" || task.status === "quarantined"
    ? "human recovery review required"
    : overdue
      ? "surface overdue worker task to recovery/operator"
      : decision === "accepted"
        ? "continue outer run transition through existing gates"
        : "wait for expected worker completion";
  return {
    active: ["created", "dispatched", "completion_received", "overdue"].includes(task.status),
    worker_task_id: task.worker_task_id,
    purpose: task.purpose,
    role: task.role,
    epoch: task.epoch,
    attempt: task.attempt,
    authority: task.authority,
    status: overdue ? "overdue" : task.status,
    decision,
    reason: safeText(task.decision?.reason, 240),
    deadline_at: task.deadline_at || null,
    overdue,
    dispatch_ref: task.dispatch?.intent_ref || task.dispatch?.dispatch_ref || null,
    completion_ref: task.completion?.completion_ref || null,
    evidence: task.completion?.evidence || {},
    next_safe_action: nextSafeAction,
  };
}
