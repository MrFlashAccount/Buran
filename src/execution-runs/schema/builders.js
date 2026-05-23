/** Durable execution-run snapshot and summary builders. */
import { SCHEMA_VERSION, GATE_STATUS, WORKER_COMPLETION_DECISION_SET, WORKER_TASK_STATUS_SET } from "../../core/modules/execution-runs/constants.js";
import { isRecord, nonEmptyString } from "../../shared/primitives.js";

/**
 * @typedef {Record<string, unknown>} JsonRecord
 */

/**
 * @typedef {{ path: string, sha256: string }} ArtifactRef
 */

/**
 * Creates the pending gate head stored in run snapshots.
 *
 * @param {number} [currentEpoch=0]
 * @returns {{ status: string, current_epoch: number, current_attempt: number, recorded_from_state: string, artifact_refs: ArtifactRef[], recorded_at: null, actor: string, idempotency_key: string }}
 */
export function buildGateSummary(currentEpoch = 0) {
  return {
    status: GATE_STATUS.PENDING,
    current_epoch: currentEpoch,
    current_attempt: 0,
    recorded_from_state: "",
    artifact_refs: [],
    recorded_at: null,
    actor: "",
    idempotency_key: "",
  };
}

/**
 * Converts an artifact.recorded payload into the durable artifact summary shape.
 *
 * @param {JsonRecord} payload
 * @returns {JsonRecord}
 */
export function buildRecordedArtifactSummary(payload) {
  return {
    path: payload.path,
    sha256: payload.sha256,
    bytes: payload.bytes,
    gate_name: payload.gate_name,
    execution_epoch: payload.execution_epoch,
    gate_attempt: payload.gate_attempt,
    recorded_from_state: payload.recorded_from_state,
    recorded_at: payload.recorded_at,
    actor: payload.actor,
    provenance: isRecord(payload.provenance) ? payload.provenance : {},
  };
}

/**
 * Converts a gate.result_recorded payload into the durable gate head shape.
 *
 * @param {JsonRecord} payload
 * @returns {JsonRecord}
 */
export function buildGateResultSummary(payload) {
  return {
    status: payload.status,
    current_epoch: payload.execution_epoch,
    current_attempt: payload.gate_attempt,
    recorded_from_state: payload.recorded_from_state,
    artifact_refs: payload.artifact_refs.map((ref) => ({ path: ref.path, sha256: ref.sha256 })),
    recorded_at: payload.recorded_at,
    actor: payload.actor,
    idempotency_key: payload.idempotency_key,
  };
}

/**
 * Builds the first durable snapshot created for an accepted packet.
 *
 * @param {JsonRecord} report
 * @param {{ createdAt: string, packetArtifactRef: ArtifactRef }} input
 * @returns {JsonRecord}
 */
function normalizeScmTarget(report) {
  const legacyGithub = isRecord(report.github) ? report.github : {};
  const raw = isRecord(report.raw) ? report.raw : {};
  const rawScmTarget = isRecord(raw.scm_target) ? raw.scm_target : {};
  const rawGithub = isRecord(raw.github) ? raw.github : {};
  const scmTarget = isRecord(report.scm_target) ? report.scm_target : {};
  return {
    provider: scmTarget.provider || rawScmTarget.provider || legacyGithub.provider || rawGithub.provider || ((legacyGithub.repo || rawGithub.repo) ? "github" : ""),
    repo: scmTarget.repo || rawScmTarget.repo || legacyGithub.repo || rawGithub.repo || "",
    issue_number: scmTarget.issue_number ?? rawScmTarget.issue_number ?? legacyGithub.issue_number ?? rawGithub.issue_number ?? null,
    intended_branch: scmTarget.intended_branch || rawScmTarget.intended_branch || legacyGithub.intended_branch || rawGithub.intended_branch || "",
    base_branch: scmTarget.base_branch || rawScmTarget.base_branch || legacyGithub.base_branch || rawGithub.base_branch || "",
  };
}

export function buildInitialRunSnapshot(report, { createdAt, packetArtifactRef }) {
  const scmTarget = normalizeScmTarget(report);
  return {
    schema_version: SCHEMA_VERSION,
    run_id: report.run_id,
    task_id: report.task_id,
    scm_target: scmTarget,
    handoff_target: null,
    packet: {
      hash: report.packet_hash || "",
      source_path: report.source_path || "",
      approval: report.approval || {},
      sufficiency_status: report.sufficiency_status,
      missing_fields: report.missing_fields,
    },
    state: "packet_received",
    last_sequence: 1,
    execution: {
      current_epoch: 0,
    },
    workspace: {
      id: null,
      path: null,
      lease_status: "not_requested",
    },
    locks: {
      repo: scmTarget.repo,
      issue: scmTarget.issue_number,
      branch: scmTarget.intended_branch,
      conflict_surface: report.conflict_surface || [],
      lease_status: "not_requested",
    },
    gates: {
      verification: buildGateSummary(0),
      internal_review: buildGateSummary(0),
    },
    artifacts: {
      packet: packetArtifactRef,
      recorded: {
        by_path: {},
      },
    },
    projection_ledger: {},
    worker_tasks: {
      head: null,
      history: [],
    },
    created_at: createdAt,
    updated_at: createdAt,
    terminal_reason: "",
  };
}

/**
 * Builds a deterministic batch identifier from packet metadata.
 *
 * @param {JsonRecord[]} reports
 * @param {string} createdAt
 * @param {(value: unknown) => string} hashFn
 * @param {(value: unknown) => string} canonicalJsonFn
 * @returns {string}
 */
export function buildBatchId(reports, createdAt, hashFn, canonicalJsonFn) {
  const inputHash = hashFn(canonicalJsonFn({
    created_at: createdAt,
    packets: reports.map((report) => ({
      task_id: report.task_id,
      run_id: report.run_id,
      packet_hash: report.packet_hash || "",
    })),
  })).slice(0, 12);
  const timestamp = createdAt.replace(/\D/g, "").slice(0, 14) || "undated";
  return `batch_${timestamp}_${inputHash}`;
}

/**
 * Builds the batch snapshot persisted under registry/batches.
 *
 * @param {JsonRecord[]} reports
 * @param {JsonRecord[]} runs
 * @param {{ registryRoot: string, createdAt: string, batchId: string }} input
 * @returns {JsonRecord}
 */
export function buildBatchSnapshot(reports, runs, { registryRoot, createdAt, batchId }) {
  const acceptedRunIds = runs.filter((run) => run.state === "queued").map((run) => run.run_id);
  const blockedRunIds = runs.filter((run) => run.state === "blocked_plan_insufficient").map((run) => run.run_id);
  const selectedRunIds = runs.map((run) => run.run_id);
  const packetHashes = reports.map((report) => report.packet_hash || "").filter(Boolean);
  return {
    schema_version: SCHEMA_VERSION,
    batch_id: batchId,
    created_at: createdAt,
    source: {
      kind: "packet_list",
      path: reports[0]?.source_path || "",
    },
    input_summary: {
      packet_count: reports.length,
      task_ids: reports.map((report) => report.task_id),
      packet_hashes: packetHashes,
    },
    selected: {
      count: selectedRunIds.length,
      run_ids: selectedRunIds,
    },
    accepted: {
      count: acceptedRunIds.length,
      run_ids: acceptedRunIds,
    },
    blocked: {
      count: blockedRunIds.length,
      run_ids: blockedRunIds,
    },
    config: {
      registry_root: registryRoot,
      autonomous_discovery: false,
      remote_writes: false,
      task_execution: false,
      runner_enabled: false,
      projections_enabled: false,
    },
  };
}

/**
 * Builds a persisted lease record from an acquisition request and resolved lock tuple.
 *
 * @param {JsonRecord} request
 * @param {JsonRecord} lock
 * @param {{ status?: string }} [options]
 * @returns {JsonRecord}
 */
export function buildLeaseRecord(request, lock, { status = "acquired" } = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    lease_id: request.lease_id,
    run_id: request.run_id,
    task_id: request.task_id,
    status,
    surface: lock.surface,
    key: lock.key,
    value: lock.value,
    workspace_id: request.workspace_id,
    workspace_path: request.workspace_path,
    repo: request.repo,
    issue_number: request.issue_number,
    branch: request.branch,
    conflict_surface: request.conflict_surface,
    acquired_at: request.acquired_at,
    expires_at: request.expires_at,
    ttl_ms: request.ttl_ms,
  };
}

function cleanArtifactRef(ref) {
  if (!isRecord(ref)) return null;
  const path = nonEmptyString(ref.path);
  const sha256 = nonEmptyString(ref.sha256);
  if (!path && !sha256) return null;
  return { ...(path ? { path } : {}), ...(sha256 ? { sha256 } : {}) };
}

function cleanRefs(refs) {
  const entries = Array.isArray(refs) ? refs : isRecord(refs) ? [refs] : [];
  return entries.map(cleanArtifactRef).filter(Boolean);
}

/** Builds the durable worker task head stored under run.json worker_tasks.head. */
export function buildWorkerTaskHead(input = {}) {
  const status = nonEmptyString(input.status);
  return {
    worker_task_id: nonEmptyString(input.worker_task_id),
    run_id: nonEmptyString(input.run_id),
    task_id: nonEmptyString(input.task_id),
    purpose: nonEmptyString(input.purpose),
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : 0,
    attempt: Number.isSafeInteger(input.attempt) ? input.attempt : 1,
    authority: nonEmptyString(input.authority),
    status: WORKER_TASK_STATUS_SET.has(status) ? status : "created",
    deadline_at: input.deadline_at ?? null,
    created_at: input.created_at,
    updated_at: input.updated_at || input.created_at,
    dispatch: isRecord(input.dispatch) ? input.dispatch : null,
    completion: isRecord(input.completion) ? input.completion : null,
    decision: isRecord(input.decision) ? input.decision : null,
    overdue_recorded_at: nonEmptyString(input.overdue_recorded_at),
    quarantine: isRecord(input.quarantine) ? input.quarantine : null,
  };
}

export function buildWorkerTaskEventPayload(input = {}) {
  return {
    worker_task_id: nonEmptyString(input.worker_task_id),
    run_id: nonEmptyString(input.run_id),
    task_id: nonEmptyString(input.task_id),
    purpose: nonEmptyString(input.purpose),
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : 0,
    attempt: Number.isSafeInteger(input.attempt) ? input.attempt : 1,
    authority: nonEmptyString(input.authority),
    status: nonEmptyString(input.status),
    deadline_at: input.deadline_at ?? null,
    recorded_at: input.recorded_at,
    idempotency_key: nonEmptyString(input.idempotency_key),
    intent_ref: cleanArtifactRef(input.intent_ref),
    dispatch_ref: cleanArtifactRef(input.dispatch_ref),
    reason: nonEmptyString(input.reason),
  };
}

export function buildWorkerCompletionPayload(input = {}) {
  return {
    worker_task_id: nonEmptyString(input.worker_task_id),
    run_id: nonEmptyString(input.run_id),
    task_id: nonEmptyString(input.task_id),
    purpose: nonEmptyString(input.purpose),
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : 0,
    attempt: Number.isSafeInteger(input.attempt) ? input.attempt : 1,
    authority: nonEmptyString(input.authority),
    status: nonEmptyString(input.status).toUpperCase(),
    completion_ref: cleanArtifactRef(input.completion_ref),
    evidence_refs: cleanRefs(input.evidence_refs),
    received_at: input.received_at || input.recorded_at,
    idempotency_key: nonEmptyString(input.idempotency_key),
  };
}

export function buildCompletionDecisionPayload(input = {}) {
  const decision = nonEmptyString(input.decision);
  return {
    worker_task_id: nonEmptyString(input.worker_task_id),
    run_id: nonEmptyString(input.run_id),
    task_id: nonEmptyString(input.task_id),
    decision: WORKER_COMPLETION_DECISION_SET.has(decision) ? decision : "deferred",
    reason: nonEmptyString(input.reason),
    decided_at: input.decided_at || input.recorded_at,
    idempotency_key: nonEmptyString(input.idempotency_key),
    completion_idempotency_key: nonEmptyString(input.completion_idempotency_key),
  };
}

export function buildWorkerTaskSummary(input = {}) {
  return {
    active: Boolean(input.active),
    worker_task_id: nonEmptyString(input.worker_task_id),
    purpose: nonEmptyString(input.purpose),
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : 0,
    attempt: Number.isSafeInteger(input.attempt) ? input.attempt : 0,
    authority: nonEmptyString(input.authority),
    status: nonEmptyString(input.status) || "none",
    decision: nonEmptyString(input.decision),
    reason: nonEmptyString(input.reason),
    deadline_at: input.deadline_at ?? null,
    overdue: Boolean(input.overdue),
    dispatch_ref: cleanArtifactRef(input.dispatch_ref),
    completion_ref: cleanArtifactRef(input.completion_ref),
    evidence: isRecord(input.evidence) ? input.evidence : {},
    next_safe_action: nonEmptyString(input.next_safe_action),
  };
}
