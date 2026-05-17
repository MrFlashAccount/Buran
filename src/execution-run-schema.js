import path from "node:path";

import {
  ARTIFACT_STAGE_NAMES,
  ARTIFACT_STAGE_STATE_BY_NAME,
  GATE_NAMES,
  GATE_RESULT_STATUSES,
  GATE_STATE_BY_NAME,
  GATE_STATUS,
  GATE_STATUS_SET,
  SCHEMA_VERSION,
  TERMINAL_STATES,
} from "./constants.js";
import {
  appendGithubPrContractErrors,
  appendGithubPrValidationErrors,
  appendProjectedPrParityErrors,
  isSuccessfulProjectionResultStatus,
} from "./projection-contract.js";
import { isKnownState } from "./state-machine.js";
import { isRecord } from "./utils.js";

const LEASE_STATUSES = new Set(["not_requested", "acquired", "blocked", "released", "stale_recovered"]);
const NON_EMPTY_GATE_NAMES = new Set(GATE_NAMES);
const NON_EMPTY_ARTIFACT_STAGE_NAMES = new Set(ARTIFACT_STAGE_NAMES);
const GATE_RESULT_STATUS_SET = new Set(GATE_RESULT_STATUSES);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTimestampString(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableInteger(value) {
  return value === null || Number.isSafeInteger(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function artifactStageAllowsEpochZero(stageName) {
  return stageName === "workspace_preparation" || stageName === "implementation_dispatch";
}

function isSafeRelativeArtifactPath(value) {
  if (!nonEmptyString(value)) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  if (!normalized || normalized === ".") return false;
  return !normalized.startsWith("..") && !path.isAbsolute(normalized);
}

function requireRecord(parent, field, errors, { pathPrefix = "" } = {}) {
  const fieldPath = pathPrefix ? `${pathPrefix}.${field}` : field;
  if (!hasOwn(parent, field)) {
    errors.push(`run.json missing required field: ${fieldPath}`);
    return null;
  }
  if (!isRecord(parent[field])) {
    errors.push(`run.json field ${fieldPath} must be an object`);
    return null;
  }
  return parent[field];
}

function requireString(parent, field, errors, { nonEmpty = false, pathPrefix = "" } = {}) {
  const fieldPath = pathPrefix ? `${pathPrefix}.${field}` : field;
  if (!hasOwn(parent, field)) {
    errors.push(`run.json missing required field: ${fieldPath}`);
    return;
  }
  if (typeof parent[field] !== "string") {
    errors.push(`run.json field ${fieldPath} must be a string`);
    return;
  }
  if (nonEmpty && !parent[field].trim()) errors.push(`run.json field ${fieldPath} must be non-empty`);
}

function requireArray(parent, field, errors, { pathPrefix = "" } = {}) {
  const fieldPath = pathPrefix ? `${pathPrefix}.${field}` : field;
  if (!hasOwn(parent, field)) {
    errors.push(`run.json missing required field: ${fieldPath}`);
    return;
  }
  if (!Array.isArray(parent[field])) errors.push(`run.json field ${fieldPath} must be an array`);
}

function requireInteger(parent, field, errors, { minimum = null, pathPrefix = "" } = {}) {
  const fieldPath = pathPrefix ? `${pathPrefix}.${field}` : field;
  if (!hasOwn(parent, field)) {
    errors.push(`run.json missing required field: ${fieldPath}`);
    return;
  }
  if (!Number.isSafeInteger(parent[field])) {
    errors.push(`run.json field ${fieldPath} must be an integer`);
    return;
  }
  if (minimum !== null && parent[field] < minimum) errors.push(`run.json field ${fieldPath} must be >= ${minimum}`);
}

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

export function validateArtifactRef(ref, errors = [], fieldPath = "artifact_ref") {
  if (!isRecord(ref)) {
    errors.push(`run.json field ${fieldPath} artifact ref must be an object`);
    return errors;
  }
  if (!nonEmptyString(ref.path)) errors.push(`run.json field ${fieldPath}.path must be a non-empty string`);
  else if (!isSafeRelativeArtifactPath(ref.path)) errors.push(`run.json field ${fieldPath}.path must be a safe relative path`);
  if (!nonEmptyString(ref.sha256)) errors.push(`run.json field ${fieldPath}.sha256 must be a non-empty string`);
  return errors;
}

function validateRecordedArtifactSummary(summary, errors, fieldPath) {
  if (!isRecord(summary)) {
    errors.push(`run.json field ${fieldPath} must be an object`);
    return;
  }
  if (!nonEmptyString(summary.path)) errors.push(`run.json field ${fieldPath}.path must be a non-empty string`);
  else if (!isSafeRelativeArtifactPath(summary.path)) errors.push(`run.json field ${fieldPath}.path must be a safe relative path`);
  if (!nonEmptyString(summary.sha256)) errors.push(`run.json field ${fieldPath}.sha256 must be a non-empty string`);
  if (!isNonNegativeInteger(summary.bytes)) errors.push(`run.json field ${fieldPath}.bytes must be a non-negative integer`);
  if (!NON_EMPTY_ARTIFACT_STAGE_NAMES.has(summary.gate_name)) errors.push(`run.json field ${fieldPath}.gate_name has unsupported value: ${summary.gate_name}`);
  if (artifactStageAllowsEpochZero(summary.gate_name)) {
    if (!isNonNegativeInteger(summary.execution_epoch)) errors.push(`run.json field ${fieldPath}.execution_epoch must be a non-negative integer`);
  } else if (!isPositiveInteger(summary.execution_epoch)) errors.push(`run.json field ${fieldPath}.execution_epoch must be a positive integer`);
  if (!isPositiveInteger(summary.gate_attempt)) errors.push(`run.json field ${fieldPath}.gate_attempt must be a positive integer`);
  if (!nonEmptyString(summary.recorded_from_state)) errors.push(`run.json field ${fieldPath}.recorded_from_state must be a non-empty string`);
  else if (summary.gate_name && ARTIFACT_STAGE_STATE_BY_NAME[summary.gate_name] !== summary.recorded_from_state) {
    errors.push(`run.json field ${fieldPath}.recorded_from_state must match gate ${summary.gate_name}`);
  }
  if (!isTimestampString(summary.recorded_at)) errors.push(`run.json field ${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(summary.actor)) errors.push(`run.json field ${fieldPath}.actor must be a non-empty string`);
  if (!isRecord(summary.provenance)) errors.push(`run.json field ${fieldPath}.provenance must be an object`);
}

function validateGateSummary(gate, gateName, errors, fieldPath, currentEpoch) {
  if (!isRecord(gate)) {
    errors.push(`run.json field ${fieldPath} must be an object`);
    return;
  }
  if (!GATE_STATUS_SET.has(gate.status)) errors.push(`run.json field ${fieldPath}.status has unsupported value: ${gate.status}`);
  if (!isNonNegativeInteger(gate.current_epoch)) errors.push(`run.json field ${fieldPath}.current_epoch must be a non-negative integer`);
  if (!isNonNegativeInteger(gate.current_attempt)) errors.push(`run.json field ${fieldPath}.current_attempt must be a non-negative integer`);
  if (!hasOwn(gate, "recorded_from_state")) errors.push(`run.json missing required field: ${fieldPath}.recorded_from_state`);
  else if (!(gate.recorded_from_state === "" || typeof gate.recorded_from_state === "string")) errors.push(`run.json field ${fieldPath}.recorded_from_state must be a string`);
  requireArray(gate, "artifact_refs", errors, { pathPrefix: fieldPath });
  if (!hasOwn(gate, "recorded_at")) errors.push(`run.json missing required field: ${fieldPath}.recorded_at`);
  else if (!(gate.recorded_at === null || isTimestampString(gate.recorded_at))) errors.push(`run.json field ${fieldPath}.recorded_at must be null or a timestamp string`);
  requireString(gate, "actor", errors, { pathPrefix: fieldPath });
  requireString(gate, "idempotency_key", errors, { pathPrefix: fieldPath });
  if (Array.isArray(gate.artifact_refs)) {
    for (let index = 0; index < gate.artifact_refs.length; index += 1) {
      validateArtifactRef(gate.artifact_refs[index], errors, `${fieldPath}.artifact_refs[${index}]`);
    }
  }

  if (gate.status === GATE_STATUS.PENDING) {
    if (gate.current_attempt !== 0) errors.push(`run.json field ${fieldPath}.current_attempt must be 0 while status=PENDING`);
    if (gate.recorded_at !== null) errors.push(`run.json field ${fieldPath}.recorded_at must be null while status=PENDING`);
    if (gate.actor !== "") errors.push(`run.json field ${fieldPath}.actor must be empty while status=PENDING`);
    if (gate.idempotency_key !== "") errors.push(`run.json field ${fieldPath}.idempotency_key must be empty while status=PENDING`);
    if (gate.recorded_from_state !== "") errors.push(`run.json field ${fieldPath}.recorded_from_state must be empty while status=PENDING`);
    if (Array.isArray(gate.artifact_refs) && gate.artifact_refs.length > 0) errors.push(`run.json field ${fieldPath}.artifact_refs must be empty while status=PENDING`);
  } else {
    if (gate.current_epoch !== currentEpoch) errors.push(`run.json field ${fieldPath}.current_epoch must match execution.current_epoch for resolved gate heads`);
    if (gate.current_attempt < 1) errors.push(`run.json field ${fieldPath}.current_attempt must be >= 1 while status=${gate.status}`);
    if (!nonEmptyString(gate.recorded_from_state)) errors.push(`run.json field ${fieldPath}.recorded_from_state must be non-empty while status=${gate.status}`);
    else if (GATE_STATE_BY_NAME[gateName] !== gate.recorded_from_state) errors.push(`run.json field ${fieldPath}.recorded_from_state must match gate ${gateName}`);
    if (!isTimestampString(gate.recorded_at)) errors.push(`run.json field ${fieldPath}.recorded_at must be a timestamp string while status=${gate.status}`);
    if (!nonEmptyString(gate.actor)) errors.push(`run.json field ${fieldPath}.actor must be non-empty while status=${gate.status}`);
    if (!nonEmptyString(gate.idempotency_key)) errors.push(`run.json field ${fieldPath}.idempotency_key must be non-empty while status=${gate.status}`);
  }
}

export function validateArtifactRecordedPayload(payload, { fieldPath = "event.evidence" } = {}) {
  const errors = [];
  if (!isRecord(payload)) {
    return { ok: false, errors: [`${fieldPath} must be an object`], error: `${fieldPath} must be an object` };
  }
  if (!nonEmptyString(payload.path)) errors.push(`${fieldPath}.path must be a non-empty string`);
  else if (!isSafeRelativeArtifactPath(payload.path)) errors.push(`${fieldPath}.path must be a safe relative path`);
  if (!nonEmptyString(payload.sha256)) errors.push(`${fieldPath}.sha256 must be a non-empty string`);
  if (!isNonNegativeInteger(payload.bytes)) errors.push(`${fieldPath}.bytes must be a non-negative integer`);
  if (!NON_EMPTY_ARTIFACT_STAGE_NAMES.has(payload.gate_name)) errors.push(`${fieldPath}.gate_name has unsupported value: ${payload.gate_name}`);
  if (artifactStageAllowsEpochZero(payload.gate_name)) {
    if (!isNonNegativeInteger(payload.execution_epoch)) errors.push(`${fieldPath}.execution_epoch must be a non-negative integer`);
  } else if (!isPositiveInteger(payload.execution_epoch)) errors.push(`${fieldPath}.execution_epoch must be a positive integer`);
  if (!isPositiveInteger(payload.gate_attempt)) errors.push(`${fieldPath}.gate_attempt must be a positive integer`);
  if (!nonEmptyString(payload.recorded_from_state)) errors.push(`${fieldPath}.recorded_from_state must be a non-empty string`);
  else if (payload.gate_name && ARTIFACT_STAGE_STATE_BY_NAME[payload.gate_name] !== payload.recorded_from_state) errors.push(`${fieldPath}.recorded_from_state must match gate ${payload.gate_name}`);
  if (!isTimestampString(payload.recorded_at)) errors.push(`${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(payload.actor)) errors.push(`${fieldPath}.actor must be a non-empty string`);
  if (!isRecord(payload.provenance)) errors.push(`${fieldPath}.provenance must be an object`);
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateArtifactRecordedEvent(event, { expectedRunId = "", expectedSequence } = {}) {
  if (!isRecord(event)) return { ok: false, errors: ["event is not an object"], error: "event is not an object" };
  const errors = [];
  if (event.schema_version !== SCHEMA_VERSION) errors.push(`unsupported event schema_version: ${event.schema_version}`);
  if (expectedRunId && event.run_id !== expectedRunId) errors.push(`event run_id mismatch: ${event.run_id}`);
  if (!Number.isSafeInteger(event.sequence)) errors.push("event sequence is not an integer");
  else if (expectedSequence !== undefined && event.sequence !== expectedSequence) errors.push(`event sequence ${event.sequence} is not expected ${expectedSequence}`);
  if (event.type !== "artifact.recorded") errors.push(`unexpected event type: ${event.type}`);
  if (!nonEmptyString(event.actor)) errors.push("event actor is missing");
  if (!nonEmptyString(event.idempotency_key)) errors.push("event idempotency_key is missing");
  const payloadDecision = validateArtifactRecordedPayload(event.evidence, { fieldPath: "event.evidence" });
  errors.push(...payloadDecision.errors);
  if (payloadDecision.ok) {
    if (event.actor !== event.evidence.actor) errors.push("event actor does not match event.evidence.actor");
    if (event.timestamp !== event.evidence.recorded_at) errors.push("event timestamp does not match event.evidence.recorded_at");
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateGateResultPayload(payload, { fieldPath = "event.evidence" } = {}) {
  const errors = [];
  if (!isRecord(payload)) {
    return { ok: false, errors: [`${fieldPath} must be an object`], error: `${fieldPath} must be an object` };
  }
  if (!NON_EMPTY_GATE_NAMES.has(payload.gate_name)) errors.push(`${fieldPath}.gate_name has unsupported value: ${payload.gate_name}`);
  if (!isPositiveInteger(payload.execution_epoch)) errors.push(`${fieldPath}.execution_epoch must be a positive integer`);
  if (!isPositiveInteger(payload.gate_attempt)) errors.push(`${fieldPath}.gate_attempt must be a positive integer`);
  if (!nonEmptyString(payload.recorded_from_state)) errors.push(`${fieldPath}.recorded_from_state must be a non-empty string`);
  else if (payload.gate_name && GATE_STATE_BY_NAME[payload.gate_name] !== payload.recorded_from_state) errors.push(`${fieldPath}.recorded_from_state must match gate ${payload.gate_name}`);
  if (!GATE_RESULT_STATUS_SET.has(payload.status)) errors.push(`${fieldPath}.status has unsupported value: ${payload.status}`);
  if (!Array.isArray(payload.artifact_refs)) errors.push(`${fieldPath}.artifact_refs must be an array`);
  else {
    for (let index = 0; index < payload.artifact_refs.length; index += 1) {
      validateArtifactRef(payload.artifact_refs[index], errors, `${fieldPath}.artifact_refs[${index}]`);
    }
  }
  if (!isTimestampString(payload.recorded_at)) errors.push(`${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(payload.actor)) errors.push(`${fieldPath}.actor must be a non-empty string`);
  if (!nonEmptyString(payload.idempotency_key)) errors.push(`${fieldPath}.idempotency_key must be a non-empty string`);
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateGateResultRecordedEvent(event, { expectedRunId = "", expectedSequence } = {}) {
  if (!isRecord(event)) return { ok: false, errors: ["event is not an object"], error: "event is not an object" };
  const errors = [];
  if (event.schema_version !== SCHEMA_VERSION) errors.push(`unsupported event schema_version: ${event.schema_version}`);
  if (expectedRunId && event.run_id !== expectedRunId) errors.push(`event run_id mismatch: ${event.run_id}`);
  if (!Number.isSafeInteger(event.sequence)) errors.push("event sequence is not an integer");
  else if (expectedSequence !== undefined && event.sequence !== expectedSequence) errors.push(`event sequence ${event.sequence} is not expected ${expectedSequence}`);
  if (event.type !== "gate.result_recorded") errors.push(`unexpected event type: ${event.type}`);
  if (!nonEmptyString(event.actor)) errors.push("event actor is missing");
  if (!nonEmptyString(event.idempotency_key)) errors.push("event idempotency_key is missing");
  const payloadDecision = validateGateResultPayload(event.evidence, { fieldPath: "event.evidence" });
  errors.push(...payloadDecision.errors);
  if (payloadDecision.ok) {
    if (event.actor !== event.evidence.actor) errors.push("event actor does not match event.evidence.actor");
    if (event.idempotency_key !== event.evidence.idempotency_key) errors.push("event idempotency_key does not match event.evidence.idempotency_key");
    if (event.timestamp !== event.evidence.recorded_at) errors.push("event timestamp does not match event.evidence.recorded_at");
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateProjectionIntentPayload(payload, { fieldPath = "event.evidence" } = {}) {
  const errors = [];
  if (!isRecord(payload)) {
    return { ok: false, errors: [`${fieldPath} must be an object`], error: `${fieldPath} must be an object` };
  }
  if (!nonEmptyString(payload.projection_name)) errors.push(`${fieldPath}.projection_name must be a non-empty string`);
  if (!nonEmptyString(payload.projection_target)) errors.push(`${fieldPath}.projection_target must be a non-empty string`);
  if (!nonEmptyString(payload.adapter)) errors.push(`${fieldPath}.adapter must be a non-empty string`);
  if (!nonEmptyString(payload.mode)) errors.push(`${fieldPath}.mode must be a non-empty string`);
  if (!isPositiveInteger(payload.execution_epoch)) errors.push(`${fieldPath}.execution_epoch must be a positive integer`);
  if (payload.recorded_from_state !== "pr_ready") errors.push(`${fieldPath}.recorded_from_state must be pr_ready`);
  if (!isTimestampString(payload.recorded_at)) errors.push(`${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(payload.actor)) errors.push(`${fieldPath}.actor must be a non-empty string`);
  if (!nonEmptyString(payload.idempotency_key)) errors.push(`${fieldPath}.idempotency_key must be a non-empty string`);
  validateArtifactRef(payload.artifact_ref, errors, `${fieldPath}.artifact_ref`);
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateProjectionResultPayload(payload, { fieldPath = "event.evidence", snapshot = null, durableContract = false } = {}) {
  const intentDecision = validateProjectionIntentPayload(payload, { fieldPath });
  const errors = [...intentDecision.errors];
  if (!nonEmptyString(payload?.status)) errors.push(`${fieldPath}.status must be a non-empty string`);
  if (!nonEmptyString(payload?.intent_idempotency_key)) errors.push(`${fieldPath}.intent_idempotency_key must be a non-empty string`);
  if (isSuccessfulProjectionResultStatus(payload?.status)) {
    appendGithubPrValidationErrors(payload.github_pr, errors, `${fieldPath}.github_pr`);
    if (snapshot) appendGithubPrContractErrors(snapshot, payload.github_pr, errors, `${fieldPath}.github_pr`, { durable: durableContract });
  } else if (!(payload.github_pr === null || isRecord(payload.github_pr))) {
    errors.push(`${fieldPath}.github_pr must be an object or null`);
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateProjectionIntentRecordedEvent(event, { expectedRunId = "", expectedSequence } = {}) {
  if (!isRecord(event)) return { ok: false, errors: ["event is not an object"], error: "event is not an object" };
  const errors = [];
  if (event.schema_version !== SCHEMA_VERSION) errors.push(`unsupported event schema_version: ${event.schema_version}`);
  if (expectedRunId && event.run_id !== expectedRunId) errors.push(`event run_id mismatch: ${event.run_id}`);
  if (!Number.isSafeInteger(event.sequence)) errors.push("event sequence is not an integer");
  else if (expectedSequence !== undefined && event.sequence !== expectedSequence) errors.push(`event sequence ${event.sequence} is not expected ${expectedSequence}`);
  if (event.type !== "projection.intent_recorded") errors.push(`unexpected event type: ${event.type}`);
  if (!nonEmptyString(event.actor)) errors.push("event actor is missing");
  if (!nonEmptyString(event.idempotency_key)) errors.push("event idempotency_key is missing");
  const payloadDecision = validateProjectionIntentPayload(event.evidence, { fieldPath: "event.evidence" });
  errors.push(...payloadDecision.errors);
  if (payloadDecision.ok) {
    if (event.actor !== event.evidence.actor) errors.push("event actor does not match event.evidence.actor");
    if (event.idempotency_key !== event.evidence.idempotency_key) errors.push("event idempotency_key does not match event.evidence.idempotency_key");
    if (event.timestamp !== event.evidence.recorded_at) errors.push("event timestamp does not match event.evidence.recorded_at");
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

export function validateProjectionResultRecordedEvent(event, { expectedRunId = "", expectedSequence, snapshot = null, durableContract = false } = {}) {
  if (!isRecord(event)) return { ok: false, errors: ["event is not an object"], error: "event is not an object" };
  const errors = [];
  if (event.schema_version !== SCHEMA_VERSION) errors.push(`unsupported event schema_version: ${event.schema_version}`);
  if (expectedRunId && event.run_id !== expectedRunId) errors.push(`event run_id mismatch: ${event.run_id}`);
  if (!Number.isSafeInteger(event.sequence)) errors.push("event sequence is not an integer");
  else if (expectedSequence !== undefined && event.sequence !== expectedSequence) errors.push(`event sequence ${event.sequence} is not expected ${expectedSequence}`);
  if (event.type !== "projection.result_recorded") errors.push(`unexpected event type: ${event.type}`);
  if (!nonEmptyString(event.actor)) errors.push("event actor is missing");
  if (!nonEmptyString(event.idempotency_key)) errors.push("event idempotency_key is missing");
  const payloadDecision = validateProjectionResultPayload(event.evidence, { fieldPath: "event.evidence", snapshot, durableContract });
  errors.push(...payloadDecision.errors);
  if (payloadDecision.ok) {
    if (event.actor !== event.evidence.actor) errors.push("event actor does not match event.evidence.actor");
    if (event.idempotency_key !== event.evidence.idempotency_key) errors.push("event idempotency_key does not match event.evidence.idempotency_key");
    if (event.timestamp !== event.evidence.recorded_at) errors.push("event timestamp does not match event.evidence.recorded_at");
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

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

export function validateLeaseRecord(record) {
  const errors = [];
  if (!isRecord(record)) return { ok: false, errors: ["lease record is not an object"], error: "lease record is not an object" };
  if (record.schema_version !== SCHEMA_VERSION) errors.push(`unsupported lease schema_version: ${record.schema_version}`);
  for (const field of ["lease_id", "run_id", "task_id", "status", "surface", "key", "value", "workspace_id", "workspace_path", "repo", "branch", "acquired_at", "expires_at"]) {
    if (!nonEmptyString(record[field])) errors.push(`lease record field ${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(record.issue_number)) errors.push("lease record field issue_number must be an integer");
  if (!Number.isSafeInteger(record.ttl_ms) || record.ttl_ms <= 0) errors.push("lease record field ttl_ms must be a positive integer");
  if (!Array.isArray(record.conflict_surface)) errors.push("lease record field conflict_surface must be an array");
  if (!LEASE_STATUSES.has(record.status)) errors.push(`lease record status has unsupported value: ${record.status}`);
  if (hasOwn(record, "acquired_at") && !isTimestampString(record.acquired_at)) errors.push("lease record field acquired_at must be a timestamp string");
  if (hasOwn(record, "expires_at") && !isTimestampString(record.expires_at)) errors.push("lease record field expires_at must be a timestamp string");
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

function validateProjectionLedgerEntry(entry, errors, fieldPath, { requireResult = false } = {}) {
  if (!isRecord(entry)) {
    errors.push(`run.json field ${fieldPath} must be an object`);
    return;
  }
  validateArtifactRef(entry.artifact_ref, errors, `${fieldPath}.artifact_ref`);
  if (!isTimestampString(entry.recorded_at)) errors.push(`run.json field ${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(entry.actor)) errors.push(`run.json field ${fieldPath}.actor must be a non-empty string`);
  if (!nonEmptyString(entry.idempotency_key)) errors.push(`run.json field ${fieldPath}.idempotency_key must be a non-empty string`);
  if (!isPositiveInteger(entry.execution_epoch)) errors.push(`run.json field ${fieldPath}.execution_epoch must be a positive integer`);
  if (entry.recorded_from_state !== "pr_ready") errors.push(`run.json field ${fieldPath}.recorded_from_state must be pr_ready`);
  if (!isPositiveInteger(entry.sequence)) errors.push(`run.json field ${fieldPath}.sequence must be a positive integer`);
  if (requireResult) {
    if (!nonEmptyString(entry.intent_idempotency_key)) errors.push(`run.json field ${fieldPath}.intent_idempotency_key must be a non-empty string`);
    if (!nonEmptyString(entry.status)) errors.push(`run.json field ${fieldPath}.status must be a non-empty string`);
    if (isSuccessfulProjectionResultStatus(entry.status)) {
      appendGithubPrValidationErrors(entry.github_pr, errors, `${fieldPath}.github_pr`);
    } else if (!(entry.github_pr === null || isRecord(entry.github_pr))) {
      errors.push(`run.json field ${fieldPath}.github_pr must be an object or null`);
    }
  }
}

function validateProjectionSummary(snapshot, projections, errors, currentEpoch) {
  const githubProjection = projections && hasOwn(projections, "github_pr") ? projections.github_pr : null;
  const githubPr = snapshot.github?.pr;

  if (!(githubPr === null || isRecord(githubPr))) errors.push("run.json field github.pr must be an object or null");
  else if (isRecord(githubPr)) appendGithubPrValidationErrors(githubPr, errors, "github.pr");

  if (githubProjection === null || githubProjection === undefined) {
    if (snapshot.state === "ready_for_manual_review") errors.push("run.json ready_for_manual_review requires projections.github_pr");
    if (isRecord(githubPr)) errors.push("run.json field github.pr requires matching projections.github_pr.last_result");
    return;
  }

  if (!isRecord(githubProjection)) {
    errors.push("run.json field projections.github_pr must be an object");
    return;
  }

  requireString(githubProjection, "projection_name", errors, { pathPrefix: "projections.github_pr", nonEmpty: true });
  requireString(githubProjection, "projection_target", errors, { pathPrefix: "projections.github_pr", nonEmpty: true });
  requireString(githubProjection, "adapter", errors, { pathPrefix: "projections.github_pr", nonEmpty: true });
  requireString(githubProjection, "mode", errors, { pathPrefix: "projections.github_pr", nonEmpty: true });
  requireInteger(githubProjection, "execution_epoch", errors, { pathPrefix: "projections.github_pr", minimum: 1 });
  requireString(githubProjection, "recorded_from_state", errors, { pathPrefix: "projections.github_pr", nonEmpty: true });
  if (hasOwn(githubProjection, "recorded_from_state") && githubProjection.recorded_from_state !== "pr_ready") {
    errors.push("run.json field projections.github_pr.recorded_from_state must be pr_ready");
  }

  const hasIntent = hasOwn(githubProjection, "last_intent");
  const hasResult = hasOwn(githubProjection, "last_result");
  if (!hasIntent && !hasResult) errors.push("run.json field projections.github_pr must include last_intent or last_result");

  if (hasIntent) validateProjectionLedgerEntry(githubProjection.last_intent, errors, "projections.github_pr.last_intent");
  if (hasResult) validateProjectionLedgerEntry(githubProjection.last_result, errors, "projections.github_pr.last_result", { requireResult: true });

  if (Number.isSafeInteger(currentEpoch) && currentEpoch > 0 && githubProjection.execution_epoch !== currentEpoch) {
    errors.push("run.json field projections.github_pr.execution_epoch must match execution.current_epoch");
  }
  if (isRecord(githubProjection.last_intent) && githubProjection.last_intent.execution_epoch !== githubProjection.execution_epoch) {
    errors.push("run.json field projections.github_pr.last_intent.execution_epoch must match projections.github_pr.execution_epoch");
  }
  if (isRecord(githubProjection.last_result) && githubProjection.last_result.execution_epoch !== githubProjection.execution_epoch) {
    errors.push("run.json field projections.github_pr.last_result.execution_epoch must match projections.github_pr.execution_epoch");
  }
  if (isRecord(githubProjection.last_result) && isRecord(githubProjection.last_intent)
    && githubProjection.last_result.intent_idempotency_key !== githubProjection.last_intent.idempotency_key) {
    errors.push("run.json field projections.github_pr.last_result.intent_idempotency_key must match projections.github_pr.last_intent.idempotency_key");
  }

  if (isRecord(githubProjection.last_result) && isSuccessfulProjectionResultStatus(githubProjection.last_result.status)) {
    appendGithubPrContractErrors(snapshot, githubProjection.last_result.github_pr, errors, "projections.github_pr.last_result.github_pr", { durable: true });
    if (!isRecord(githubPr)) {
      errors.push("run.json successful projections.github_pr.last_result requires github.pr");
    } else {
      appendGithubPrContractErrors(snapshot, githubPr, errors, "github.pr", { durable: true });
      appendProjectedPrParityErrors(githubPr, githubProjection.last_result.github_pr, errors, "github.pr", "projections.github_pr.last_result.github_pr");
    }
  } else if (isRecord(githubPr)) {
    errors.push("run.json field github.pr requires a successful projections.github_pr.last_result");
  }

  if (snapshot.state === "ready_for_manual_review") {
    if (!isRecord(githubProjection.last_result) || !isSuccessfulProjectionResultStatus(githubProjection.last_result.status)) {
      errors.push("run.json ready_for_manual_review requires a successful projections.github_pr.last_result");
    }
  }
}

export function validateRunSnapshot(snapshot, { expectedRunId = "", mode = "recovery" } = {}) {
  if (!isRecord(snapshot)) return { ok: false, errors: ["run.json is not an object"], error: "run.json is not an object", mode };
  if (snapshot.schema_version !== SCHEMA_VERSION) {
    return { ok: false, errors: [`unsupported run.json schema_version: ${snapshot.schema_version}`], error: `unsupported run.json schema_version: ${snapshot.schema_version}`, mode };
  }
  if (expectedRunId && snapshot.run_id !== expectedRunId) {
    return { ok: false, errors: [`run.json run_id ${snapshot.run_id} does not match folder ${expectedRunId}`], error: `run.json run_id ${snapshot.run_id} does not match folder ${expectedRunId}`, mode };
  }
  if (!isKnownState(snapshot.state)) return { ok: false, errors: [`unknown run state: ${snapshot.state}`], error: `unknown run state: ${snapshot.state}`, mode };

  const errors = [];
  requireString(snapshot, "run_id", errors, { nonEmpty: true });
  requireString(snapshot, "task_id", errors, { nonEmpty: true });
  requireString(snapshot, "created_at", errors);
  requireString(snapshot, "updated_at", errors);
  requireInteger(snapshot, "last_sequence", errors, { minimum: 1 });
  if (hasOwn(snapshot, "created_at") && !isTimestampString(snapshot.created_at)) errors.push("run.json field created_at must be a timestamp string");
  if (hasOwn(snapshot, "updated_at") && !isTimestampString(snapshot.updated_at)) errors.push("run.json field updated_at must be a timestamp string");
  requireString(snapshot, "terminal_reason", errors);
  if (TERMINAL_STATES.has(snapshot.state) && snapshot.state !== "ready_for_manual_review" && hasOwn(snapshot, "terminal_reason") && !snapshot.terminal_reason.trim()) {
    errors.push("run.json terminal_reason must be non-empty for terminal blocked/failed states");
  }

  const github = requireRecord(snapshot, "github", errors);
  if (github) {
    requireString(github, "repo", errors, { pathPrefix: "github", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    if (!hasOwn(github, "issue_number")) errors.push("run.json missing required field: github.issue_number");
    else if (!isNullableInteger(github.issue_number)) errors.push("run.json field github.issue_number must be an integer or null");
    else if (!TERMINAL_STATES.has(snapshot.state) && github.issue_number === null) errors.push("run.json field github.issue_number must be non-null for active states");
    requireString(github, "intended_branch", errors, { pathPrefix: "github", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    if (hasOwn(github, "base_branch") && !(github.base_branch === "" || typeof github.base_branch === "string")) {
      errors.push("run.json field github.base_branch must be a string when present");
    }
    if (!hasOwn(github, "pr")) errors.push("run.json missing required field: github.pr");
  }

  const packet = requireRecord(snapshot, "packet", errors);
  if (packet) {
    requireString(packet, "hash", errors, { pathPrefix: "packet" });
    requireString(packet, "source_path", errors, { pathPrefix: "packet" });
    if (!hasOwn(packet, "approval")) errors.push("run.json missing required field: packet.approval");
    else if (!isRecord(packet.approval)) errors.push("run.json field packet.approval must be an object");
    requireString(packet, "sufficiency_status", errors, { pathPrefix: "packet" });
    requireArray(packet, "missing_fields", errors, { pathPrefix: "packet" });
  }

  const execution = requireRecord(snapshot, "execution", errors);
  if (execution) requireInteger(execution, "current_epoch", errors, { minimum: 0, pathPrefix: "execution" });
  const currentEpoch = execution?.current_epoch ?? 0;

  const workspace = requireRecord(snapshot, "workspace", errors);
  if (workspace) {
    if (!hasOwn(workspace, "id")) errors.push("run.json missing required field: workspace.id");
    else if (!isNullableString(workspace.id)) errors.push("run.json field workspace.id must be a string or null");
    if (!hasOwn(workspace, "path")) errors.push("run.json missing required field: workspace.path");
    else if (!isNullableString(workspace.path)) errors.push("run.json field workspace.path must be a string or null");
    requireString(workspace, "lease_status", errors, { pathPrefix: "workspace", nonEmpty: true });
    if (hasOwn(workspace, "lease_status") && !LEASE_STATUSES.has(workspace.lease_status)) errors.push(`run.json field workspace.lease_status has unsupported value: ${workspace.lease_status}`);
  }

  const locks = requireRecord(snapshot, "locks", errors);
  if (locks) {
    requireString(locks, "repo", errors, { pathPrefix: "locks", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    if (!hasOwn(locks, "issue")) errors.push("run.json missing required field: locks.issue");
    else if (!isNullableInteger(locks.issue)) errors.push("run.json field locks.issue must be an integer or null");
    else if (!TERMINAL_STATES.has(snapshot.state) && locks.issue === null) errors.push("run.json field locks.issue must be non-null for active states");
    requireString(locks, "branch", errors, { pathPrefix: "locks", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    requireArray(locks, "conflict_surface", errors, { pathPrefix: "locks" });
    requireString(locks, "lease_status", errors, { pathPrefix: "locks", nonEmpty: true });
    if (hasOwn(locks, "lease_status") && !LEASE_STATUSES.has(locks.lease_status)) errors.push(`run.json field locks.lease_status has unsupported value: ${locks.lease_status}`);
  }

  const gates = requireRecord(snapshot, "gates", errors);
  for (const gateName of GATE_NAMES) {
    const gate = gates ? requireRecord(gates, gateName, errors, { pathPrefix: "gates" }) : null;
    if (gate) validateGateSummary(gate, gateName, errors, `gates.${gateName}`, currentEpoch);
  }

  const artifacts = requireRecord(snapshot, "artifacts", errors);
  if (artifacts) {
    validateArtifactRef(artifacts.packet, errors, "artifacts.packet");
    const recorded = requireRecord(artifacts, "recorded", errors, { pathPrefix: "artifacts" });
    const byPath = recorded ? requireRecord(recorded, "by_path", errors, { pathPrefix: "artifacts.recorded" }) : null;
    if (byPath) {
      for (const [artifactPath, summary] of Object.entries(byPath)) {
        validateRecordedArtifactSummary(summary, errors, `artifacts.recorded.by_path.${artifactPath}`);
        if (summary?.path !== artifactPath) errors.push(`run.json field artifacts.recorded.by_path.${artifactPath}.path must match the map key`);
      }
    }
  }
  const projections = requireRecord(snapshot, "projections", errors);
  if (projections) validateProjectionSummary(snapshot, projections, errors, currentEpoch);

  return { ok: errors.length === 0, errors, error: errors.join("; "), mode };
}

export function findArtifactRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const entry of value) findArtifactRefs(entry, refs);
    return refs;
  }
  if (!isRecord(value)) return refs;
  if (typeof value.path === "string" && typeof value.sha256 === "string") refs.push({ path: value.path, sha256: value.sha256 });
  for (const entry of Object.values(value)) findArtifactRefs(entry, refs);
  return refs;
}
