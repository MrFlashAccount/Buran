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
} from "../../core/modules/execution-runs/constants.js";
import { isKnownState } from "../../core/modules/execution-runs/state-machine.js";
import { isRecord } from "../../shared/primitives.js";
import { appendScmHandoffTargetContractErrors, appendScmHandoffTargetValidationErrors } from "../../core/modules/scm-handoff/contract.js";
import { buildGateSummary } from "./builders.js";

/**
 * Schema validators for durable execution-run snapshots, events, and lease records.
 *
 * Responsibilities:
 * - create normalized summary objects written into run.json, batch.json, and lease ledgers;
 * - validate persisted payloads before registry-store writes them;
 * - keep replay/recovery contracts centralized and schema-version aware.
 *
 * Non-goals:
 * - file I/O, sequence allocation, or state transitions;
 * - auto-fixing invalid payloads.
 */

/**
 * @typedef {Record<string, unknown>} JsonRecord
 */

/**
 * @typedef {{ path: string, sha256: string }} ArtifactRef
 */

const LEASE_STATUSES = new Set(["not_requested", "acquired", "blocked", "released", "stale_recovered"]);
const NON_EMPTY_GATE_NAMES = new Set(GATE_NAMES);
const NON_EMPTY_ARTIFACT_STAGE_NAMES = new Set(ARTIFACT_STAGE_NAMES);
const GATE_RESULT_STATUS_SET = new Set(GATE_RESULT_STATUSES);


function isSuccessfulProjectionLedgerStatus(status) {
  return ["projected_local", "projected", "created", "updated"].includes(typeof status === "string" ? status.trim() : "");
}

function validateHandoffTarget(value, errors, fieldPath, { snapshot = null, durableContract = false } = {}) {
  appendScmHandoffTargetValidationErrors(value, errors, fieldPath);
  if (!isRecord(value)) return;
  if (snapshot) appendScmHandoffTargetContractErrors(snapshot, value, errors, fieldPath, { durable: durableContract });
}
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

/**
 * Validates a lightweight artifact reference.
 *
 * @param {unknown} ref
 * @param {string[]} [errors=[]]
 * @param {string} [fieldPath="artifact_ref"]
 * @returns {string[]}
 */
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

/**
 * Validates an artifact.recorded payload before it is journaled or merged into run.json.
 *
 * @param {unknown} payload
 * @param {{ fieldPath?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a persisted artifact.recorded event envelope.
 *
 * @param {unknown} event
 * @param {{ expectedRunId?: string, expectedSequence?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a gate.result_recorded payload before persistence.
 *
 * @param {unknown} payload
 * @param {{ fieldPath?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a persisted gate.result_recorded event envelope.
 *
 * @param {unknown} event
 * @param {{ expectedRunId?: string, expectedSequence?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a projection intent payload written from handoff_ready.
 *
 * @param {unknown} payload
 * @param {{ fieldPath?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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
  if (payload.recorded_from_state !== "handoff_ready") errors.push(`${fieldPath}.recorded_from_state must be handoff_ready`);
  if (!isTimestampString(payload.recorded_at)) errors.push(`${fieldPath}.recorded_at must be a timestamp string`);
  if (!nonEmptyString(payload.actor)) errors.push(`${fieldPath}.actor must be a non-empty string`);
  if (!nonEmptyString(payload.idempotency_key)) errors.push(`${fieldPath}.idempotency_key must be a non-empty string`);
  validateArtifactRef(payload.artifact_ref, errors, `${fieldPath}.artifact_ref`);
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

/**
 * Validates a projection result payload, optionally against the current snapshot contract.
 *
 * @param {unknown} payload
 * @param {{ fieldPath?: string, snapshot?: JsonRecord | null, durableContract?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
export function validateProjectionResultPayload(payload, { fieldPath = "event.evidence", snapshot = null, durableContract = false } = {}) {
  const intentDecision = validateProjectionIntentPayload(payload, { fieldPath });
  const errors = [...intentDecision.errors];
  if (!nonEmptyString(payload?.status)) errors.push(`${fieldPath}.status must be a non-empty string`);
  if (!nonEmptyString(payload?.intent_idempotency_key)) errors.push(`${fieldPath}.intent_idempotency_key must be a non-empty string`);
  if (isSuccessfulProjectionLedgerStatus(payload?.status)) {
    validateHandoffTarget(payload.handoff_target, errors, `${fieldPath}.handoff_target`, { snapshot, durableContract });
    if (snapshot && isRecord(snapshot.handoff_target) && JSON.stringify(snapshot.handoff_target) !== JSON.stringify(payload.handoff_target)) {
      errors.push(`${fieldPath}.handoff_target must match snapshot.handoff_target`);
    }
  } else if (!(payload.handoff_target === null || isRecord(payload.handoff_target))) {
    errors.push(`${fieldPath}.handoff_target must be an object or null`);
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

/**
 * Validates a persisted projection.intent_recorded event envelope.
 *
 * @param {unknown} event
 * @param {{ expectedRunId?: string, expectedSequence?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a persisted projection.result_recorded event envelope.
 *
 * @param {unknown} event
 * @param {{ expectedRunId?: string, expectedSequence?: number, snapshot?: JsonRecord | null, durableContract?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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

/**
 * Validates a persisted lease record.
 *
 * @param {unknown} record
 * @returns {{ ok: boolean, errors: string[], error: string }}
 */
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
  if (entry.recorded_from_state !== "handoff_ready") errors.push(`run.json field ${fieldPath}.recorded_from_state must be handoff_ready`);
  if (!isPositiveInteger(entry.sequence)) errors.push(`run.json field ${fieldPath}.sequence must be a positive integer`);
  if (requireResult) {
    if (!nonEmptyString(entry.intent_idempotency_key)) errors.push(`run.json field ${fieldPath}.intent_idempotency_key must be a non-empty string`);
    if (!nonEmptyString(entry.status)) errors.push(`run.json field ${fieldPath}.status must be a non-empty string`);
    if (isSuccessfulProjectionLedgerStatus(entry.status)) {
      validateHandoffTarget(entry.handoff_target, errors, `${fieldPath}.handoff_target`);
    } else if (!(entry.handoff_target === null || isRecord(entry.handoff_target))) {
      errors.push(`run.json field ${fieldPath}.handoff_target must be an object or null`);
    }
  }
}

function validateProjectionSummary(snapshot, projectionLedger, errors, currentEpoch) {
  const handoffProjection = projectionLedger && hasOwn(projectionLedger, "handoff_target") ? projectionLedger.handoff_target : null;
  const handoffTarget = snapshot.handoff_target;

  if (!(handoffTarget === null || isRecord(handoffTarget))) errors.push("run.json field handoff_target must be an object or null");
  else if (isRecord(handoffTarget)) validateHandoffTarget(handoffTarget, errors, "handoff_target");

  if (handoffProjection === null || handoffProjection === undefined) {
    if (snapshot.state === "ready_for_manual_review") errors.push("run.json ready_for_manual_review requires projection_ledger.handoff_target");
    if (isRecord(handoffTarget)) errors.push("run.json field handoff_target requires matching projection_ledger.handoff_target.last_result");
    return;
  }

  if (!isRecord(handoffProjection)) {
    errors.push("run.json field projection_ledger.handoff_target must be an object");
    return;
  }

  requireString(handoffProjection, "projection_name", errors, { pathPrefix: "projection_ledger.handoff_target", nonEmpty: true });
  requireString(handoffProjection, "projection_target", errors, { pathPrefix: "projection_ledger.handoff_target", nonEmpty: true });
  requireString(handoffProjection, "adapter", errors, { pathPrefix: "projection_ledger.handoff_target", nonEmpty: true });
  requireString(handoffProjection, "mode", errors, { pathPrefix: "projection_ledger.handoff_target", nonEmpty: true });
  requireInteger(handoffProjection, "execution_epoch", errors, { pathPrefix: "projection_ledger.handoff_target", minimum: 1 });
  requireString(handoffProjection, "recorded_from_state", errors, { pathPrefix: "projection_ledger.handoff_target", nonEmpty: true });
  if (hasOwn(handoffProjection, "recorded_from_state") && handoffProjection.recorded_from_state !== "handoff_ready") {
    errors.push("run.json field projection_ledger.handoff_target.recorded_from_state must be handoff_ready");
  }

  const hasIntent = hasOwn(handoffProjection, "last_intent");
  const hasResult = hasOwn(handoffProjection, "last_result");
  if (!hasIntent && !hasResult) errors.push("run.json field projection_ledger.handoff_target must include last_intent or last_result");

  if (hasIntent) validateProjectionLedgerEntry(handoffProjection.last_intent, errors, "projection_ledger.handoff_target.last_intent");
  if (hasResult) validateProjectionLedgerEntry(handoffProjection.last_result, errors, "projection_ledger.handoff_target.last_result", { requireResult: true });

  if (Number.isSafeInteger(currentEpoch) && currentEpoch > 0 && handoffProjection.execution_epoch !== currentEpoch) {
    errors.push("run.json field projection_ledger.handoff_target.execution_epoch must match execution.current_epoch");
  }
  if (isRecord(handoffProjection.last_intent) && handoffProjection.last_intent.execution_epoch !== handoffProjection.execution_epoch) {
    errors.push("run.json field projection_ledger.handoff_target.last_intent.execution_epoch must match projection_ledger.handoff_target.execution_epoch");
  }
  if (isRecord(handoffProjection.last_result) && handoffProjection.last_result.execution_epoch !== handoffProjection.execution_epoch) {
    errors.push("run.json field projection_ledger.handoff_target.last_result.execution_epoch must match projection_ledger.handoff_target.execution_epoch");
  }
  if (isRecord(handoffProjection.last_result) && isRecord(handoffProjection.last_intent)
    && handoffProjection.last_result.intent_idempotency_key !== handoffProjection.last_intent.idempotency_key) {
    errors.push("run.json field projection_ledger.handoff_target.last_result.intent_idempotency_key must match projection_ledger.handoff_target.last_intent.idempotency_key");
  }

  if (isRecord(handoffProjection.last_result) && isSuccessfulProjectionLedgerStatus(handoffProjection.last_result.status)) {
    if (!isRecord(handoffTarget)) errors.push("run.json successful projection_ledger.handoff_target.last_result requires handoff_target");
    else if (JSON.stringify(handoffTarget) !== JSON.stringify(handoffProjection.last_result.handoff_target)) {
      errors.push("run.json field handoff_target must match projection_ledger.handoff_target.last_result.handoff_target");
    }
  } else if (isRecord(handoffTarget)) {
    errors.push("run.json field handoff_target requires a successful projection_ledger.handoff_target.last_result");
  }

  if (snapshot.state === "ready_for_manual_review") {
    if (!isRecord(handoffProjection.last_result) || !isSuccessfulProjectionLedgerStatus(handoffProjection.last_result.status)) {
      errors.push("run.json ready_for_manual_review requires a successful projection_ledger.handoff_target.last_result");
    }
  }
}

/**
 * Validates a full run snapshot as stored in registry/runs/<runId>/run.json.
 *
 * @param {unknown} snapshot
 * @param {{ expectedRunId?: string, mode?: string }} [options]
 * @returns {{ ok: boolean, errors: string[], error: string, mode: string }}
 */
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

  const scmTarget = requireRecord(snapshot, "scm_target", errors);
  if (scmTarget) {
    requireString(scmTarget, "provider", errors, { pathPrefix: "scm_target", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    requireString(scmTarget, "repo", errors, { pathPrefix: "scm_target", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    if (!hasOwn(scmTarget, "issue_number")) errors.push("run.json missing required field: scm_target.issue_number");
    else if (!isNullableInteger(scmTarget.issue_number)) errors.push("run.json field scm_target.issue_number must be an integer or null");
    else if (!TERMINAL_STATES.has(snapshot.state) && scmTarget.issue_number === null) errors.push("run.json field scm_target.issue_number must be non-null for active states");
    requireString(scmTarget, "intended_branch", errors, { pathPrefix: "scm_target", nonEmpty: !TERMINAL_STATES.has(snapshot.state) });
    if (hasOwn(scmTarget, "base_branch") && !(scmTarget.base_branch === "" || typeof scmTarget.base_branch === "string")) {
      errors.push("run.json field scm_target.base_branch must be a string when present");
    }
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
  const projectionLedger = requireRecord(snapshot, "projection_ledger", errors);
  if (projectionLedger) validateProjectionSummary(snapshot, projectionLedger, errors, currentEpoch);

  return { ok: errors.length === 0, errors, error: errors.join("; "), mode };
}

/**
 * Recursively collects every nested artifact reference-like object.
 *
 * @param {unknown} value
 * @param {ArtifactRef[]} [refs=[]]
 * @returns {ArtifactRef[]}
 */
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
