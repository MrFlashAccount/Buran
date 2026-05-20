/** Durable execution-run snapshot and summary builders. */
import { SCHEMA_VERSION, GATE_STATUS } from "../constants.js";
import { isRecord } from "../../shared/primitives.js";

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
export function buildInitialRunSnapshot(report, { createdAt, packetArtifactRef }) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: report.run_id,
    task_id: report.task_id,
    github: {
      repo: report.github.repo || "",
      issue_number: report.github.issue_number || null,
      intended_branch: report.github.intended_branch || "",
      base_branch: report.github.base_branch || "",
      pr: null,
    },
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
      repo: report.github.repo || "",
      issue: report.github.issue_number || null,
      branch: report.github.intended_branch || "",
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
    projections: {},
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
