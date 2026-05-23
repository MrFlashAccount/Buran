import { promises as fs } from "node:fs";
import path from "node:path";

import { ARTIFACT_STAGE_STATE_BY_NAME, GATE_STATE_BY_NAME, GATE_STATUS, SCHEMA_VERSION, TERMINAL_STATES } from "../../../core/modules/execution-runs/constants.js";
import { applyCompletionDecisionToWorkerTask, completionDecisionMutatesCurrentTruth, createWorkerTask, deriveWorkerTaskSummary, evaluateWorkerCompletion, markWorkerTaskOverdue, normalizeWorkerCompletion, quarantineWorkerTask, recordWorkerTaskDispatch as recordWorkerTaskDispatchCore } from "../../../core/modules/execution-runs/entities/worker-task.js";
import {
  buildBatchId,
  buildBatchSnapshot,
  buildGateResultSummary,
  buildInitialRunSnapshot,
  buildRecordedArtifactSummary,
  validateArtifactRecordedPayload,
  validateGateResultPayload,
  validateProjectionResultPayload,
  validateWorkerTaskEventPayload,
  validateWorkerCompletionPayload,
  validateCompletionDecisionPayload,
} from "../../../execution-runs/schema/index.js";
import { appendJsonLine, writeJsonAtomic, writeTextAtomic } from "./atomic-read-write.js";
import { getRegistryPaths, getRunPaths } from "./path-layout.js";
import { appendRunEvent, lastEventSequence, nextSequence, readArtifactRecordedEventsByPath, readEventsByIdempotency, readEventsFile } from "./event-journal.js";
import { removeLeaseRecordsForRun } from "./lease-records.js";
import { rebuildIndexes } from "./indexes-snapshots.js";
import { isSuccessfulProjectionResultStatus, mergeProjectionSnapshot, sanitizeProjectionDurableValue } from "../../../core/modules/scm-handoff/contract.js";
import { applyTransitionToSnapshot, buildNonTransitionEvent, buildTransitionEvent } from "../../../core/modules/execution-runs/state-machine.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../../../shared/primitives.js";


export { appendRunEvent, readEventsFile } from "./event-journal.js";
export { rebuildIndexes, hashRunSnapshot } from "./indexes-snapshots.js";
export { removeLeaseRecordPath, removeLeaseRecordsForRun, writeLeaseRecordExclusive } from "./lease-records.js";
export { getRegistryPaths, getRunPaths } from "./path-layout.js";

/**
 * Durable registry read/write helpers for run snapshots, journals, indexes, and projection artifacts.
 *
 * Responsibilities:
 * - serialize state-machine results into run.json and events.jsonl;
 * - enforce write-time contracts for artifacts, gate results, and projections;
 * - rebuild derived indexes from persisted snapshots.
 *
 * Non-goals:
 * - deciding which transitions should happen next;
 * - mutating business payloads beyond projection sanitization required for durable storage.
 *
 * Side effects:
 * - writes files under registryRoot;
 * - may remove lease record files after terminal transitions.
 */

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecordLike(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function artifactRef(runDir, absolutePath, content) {
  return {
    path: path.relative(runDir, absolutePath),
    sha256: sha256Hex(content),
  };
}

function artifactStateForName(stageName) {
  return ARTIFACT_STAGE_STATE_BY_NAME[stageName] || "";
}

function isTerminal(snapshot) {
  return TERMINAL_STATES.has(snapshot.state);
}

function resolveArtifactPath(runDir, requestedPath) {
  const input = nonEmptyString(requestedPath);
  if (!input) throw new Error("artifactPath is required");
  if (path.isAbsolute(input)) throw new Error(`artifact path must be relative to the run directory: ${requestedPath}`);
  const normalized = path.normalize(input);
  const absolutePath = path.resolve(runDir, normalized);
  const relativePath = path.relative(runDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`artifact path escapes the run directory: ${requestedPath}`);
  }
  if (!(relativePath === "artifacts" || relativePath.startsWith(`artifacts${path.sep}`))) {
    throw new Error(`artifact path must stay under artifacts/: ${requestedPath}`);
  }
  return { absolutePath, relativePath };
}

function gateHead(snapshot, gateName) {
  return snapshot.gates?.[gateName] || { status: GATE_STATUS.PENDING, current_attempt: 0 };
}

function expectedArtifactAttempt(snapshot, gateName) {
  return (gateHead(snapshot, gateName).current_attempt || 0) + 1;
}

function ensureArtifactWritePhase(snapshot, { gateName, executionEpoch, gateAttempt, recordedFromState, kind }) {
  if (!snapshot?.run_id) throw new Error("run snapshot is required");
  if (isTerminal(snapshot)) throw new Error(`${kind} is forbidden in terminal state ${snapshot.state}`);
  const expectedState = artifactStateForName(gateName);
  if (!expectedState) throw new Error(`${kind} requires a supported gate_name`);
  if (snapshot.state !== expectedState) throw new Error(`${kind} requires state ${expectedState}; current state: ${snapshot.state}`);
  if (recordedFromState !== snapshot.state) throw new Error(`${kind} recorded_from_state ${recordedFromState} does not match current state ${snapshot.state}`);
  if (!Number.isSafeInteger(snapshot.execution?.current_epoch) || snapshot.execution.current_epoch < 0) {
    throw new Error(`${kind} requires a valid execution epoch`);
  }
  if (executionEpoch !== snapshot.execution.current_epoch) {
    throw new Error(`${kind} execution_epoch ${executionEpoch} does not match current epoch ${snapshot.execution.current_epoch}`);
  }

  if (!GATE_STATE_BY_NAME[gateName]) {
    if (gateAttempt !== 1) throw new Error(`${kind} gate_attempt ${gateAttempt} is stale or out of order; expected 1`);
    return;
  }

  if (snapshot.execution.current_epoch < 1) throw new Error(`${kind} requires an active execution epoch`);
  const gate = gateHead(snapshot, gateName);
  if (gate.status !== GATE_STATUS.PENDING) {
    throw new Error(`${kind} cannot write after gate ${gateName} already resolved with status ${gate.status}`);
  }
  const expectedAttempt = expectedArtifactAttempt(snapshot, gateName);
  if (gateAttempt !== expectedAttempt) {
    throw new Error(`${kind} gate_attempt ${gateAttempt} is stale or out of order; expected ${expectedAttempt}`);
  }
}

function withArtifactRecordedSnapshot(snapshot, summary, sequence) {
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: summary.recorded_at,
    artifacts: {
      ...(snapshot.artifacts || {}),
      recorded: {
        by_path: {
          ...(snapshot.artifacts?.recorded?.by_path || {}),
          [summary.path]: summary,
        },
      },
    },
  };
}

function withGateResultSnapshot(snapshot, summary, sequence) {
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: summary.recorded_at,
    gates: {
      ...(snapshot.gates || {}),
      [summary.recorded_from_state === "verification" ? "verification" : "internal_review"]: summary,
    },
  };
}

async function readArtifactIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return { exists: true, content, sha256: sha256Hex(content) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: null, sha256: "" };
    throw error;
  }
}

async function verifyOrRecoverArtifactFile(resolvedPath, contentBuffer, expectedSha256) {
  const existingFile = await readArtifactIfExists(resolvedPath.absolutePath);
  if (!existingFile.exists) {
    await writeTextAtomic(resolvedPath.absolutePath, contentBuffer.toString("utf8"));
    return { recovered: true };
  }
  if (existingFile.sha256 !== expectedSha256) {
    throw new Error(`artifact path ${resolvedPath.relativePath} already exists with different hash`);
  }
  return { recovered: false };
}

function samePayload(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sameArtifactRecordedPayload(left, right) {
  if (!left || !right) return false;
  const normalize = (payload) => {
    const { recorded_at: _recordedAt, ...rest } = payload;
    return rest;
  };
  return samePayload(normalize(left), normalize(right));
}

function sameIdempotentWorkerTaskPayload(left, right) {
  if (!left || !right) return false;
  const normalize = (payload) => {
    const { recorded_at: _recordedAt, received_at: _receivedAt, decided_at: _decidedAt, ...rest } = payload;
    return rest;
  };
  return samePayload(normalize(left), normalize(right));
}

function mergeArtifactSummary(snapshot, summary, sequence) {
  const existingSummary = snapshot.artifacts?.recorded?.by_path?.[summary.path];
  if (samePayload(existingSummary || null, summary)) return snapshot;
  const snapshotSequence = Number.isSafeInteger(snapshot?.last_sequence) ? snapshot.last_sequence : 0;
  return {
    ...snapshot,
    last_sequence: Math.max(snapshotSequence, sequence),
    updated_at: typeof snapshot.updated_at === "string" && snapshot.updated_at > summary.recorded_at ? snapshot.updated_at : summary.recorded_at,
    artifacts: {
      ...(snapshot.artifacts || {}),
      recorded: {
        by_path: {
          ...(snapshot.artifacts?.recorded?.by_path || {}),
          [summary.path]: summary,
        },
      },
    },
  };
}

function assertArtifactRefsAvailable(snapshot, payload) {
  const recordedArtifacts = snapshot.artifacts?.recorded?.by_path || {};
  for (const ref of payload.artifact_refs) {
    const summary = recordedArtifacts[ref.path];
    if (!summary) throw new Error(`gate result references missing artifact ${ref.path}`);
    if (summary.sha256 !== ref.sha256) throw new Error(`gate result references artifact ${ref.path} with mismatched hash`);
    if (summary.gate_name !== payload.gate_name) throw new Error(`gate result references artifact ${ref.path} from gate ${summary.gate_name}`);
    if (summary.execution_epoch !== payload.execution_epoch) throw new Error(`gate result references artifact ${ref.path} from epoch ${summary.execution_epoch}`);
    if (summary.gate_attempt !== payload.gate_attempt) throw new Error(`gate result references artifact ${ref.path} from attempt ${summary.gate_attempt}`);
  }
}

function isTimestampString(value) {
  return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function validateProjectionPayload(payload, { type }) {
  const errors = [];
  if (!isRecord(payload)) errors.push("projection payload must be an object");
  if (!nonEmptyString(type)) errors.push("projection event type is required");
  if (!nonEmptyString(payload?.projection_name)) errors.push("projection_name must be a non-empty string");
  if (!nonEmptyString(payload?.projection_target)) errors.push("projection_target must be a non-empty string");
  if (!nonEmptyString(payload?.adapter)) errors.push("adapter must be a non-empty string");
  if (!nonEmptyString(payload?.mode)) errors.push("mode must be a non-empty string");
  if (!Number.isSafeInteger(payload?.execution_epoch) || payload.execution_epoch < 1) errors.push("execution_epoch must be a positive integer");
  if (payload?.recorded_from_state !== "handoff_ready") errors.push("recorded_from_state must be handoff_ready");
  if (!isTimestampString(payload?.recorded_at)) errors.push("recorded_at must be a timestamp string");
  if (!nonEmptyString(payload?.actor)) errors.push("actor must be a non-empty string");
  if (!nonEmptyString(payload?.idempotency_key)) errors.push("idempotency_key must be a non-empty string");
  if (!isRecord(payload?.artifact_ref) || !nonEmptyString(payload?.artifact_ref?.path) || !nonEmptyString(payload?.artifact_ref?.sha256)) {
    errors.push("artifact_ref must include non-empty path and sha256");
  }
  if (type === "projection.result_recorded") {
    const projectionDecision = validateProjectionResultPayload(payload);
    errors.push(...projectionDecision.errors.map((error) => error.replace(/^event\.evidence\./, "")));
  }
  return { ok: errors.length === 0, errors, error: errors.join("; ") };
}

function ensureProjectionWritePhase(snapshot, payload, type) {
  if (!snapshot?.run_id) throw new Error(`${type} requires a run snapshot`);
  if (isTerminal(snapshot)) throw new Error(`${type} is forbidden in terminal state ${snapshot.state}`);
  if (snapshot.state !== "handoff_ready") throw new Error(`${type} requires state handoff_ready; current state: ${snapshot.state}`);
  if (!Number.isSafeInteger(snapshot.execution?.current_epoch) || snapshot.execution.current_epoch < 1) {
    throw new Error(`${type} requires an active execution epoch`);
  }
  if (payload.execution_epoch !== snapshot.execution.current_epoch) {
    throw new Error(`${type} execution_epoch ${payload.execution_epoch} does not match current epoch ${snapshot.execution.current_epoch}`);
  }
}

async function recordProjectionEvent(registryRoot, runId, {
  type,
  artifactPath,
  content,
  actor = "registry",
  recorded_at = new Date().toISOString(),
  ...payload
} = {}) {
  const eventType = type;
  const payloadDecision = validateProjectionPayload({
    ...payload,
    actor,
    recorded_at,
    artifact_ref: { path: "placeholder", sha256: "placeholder" },
  }, { type: eventType });
  if (!payloadDecision.ok) {
    const filtered = payloadDecision.errors.filter((error) => !error.startsWith("artifact_ref "));
    if (filtered.length > 0) throw new Error(filtered.join("; "));
  }

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  ensureProjectionWritePhase(snapshot, payload, eventType);

  const resolved = resolveArtifactPath(paths.runDir, artifactPath);
  const sanitizedContentText = sanitizeProjectionDurableValue(Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? ""));
  const contentBuffer = Buffer.from(sanitizedContentText, "utf8");
  const artifact_ref = { path: resolved.relativePath, sha256: sha256Hex(contentBuffer) };
  const sanitizedPayload = {
    ...payload,
    ...(hasOwn(payload, "handoff_target") ? { handoff_target: sanitizeProjectionDurableValue(payload.handoff_target) } : {}),
    ...(hasOwn(payload, "status") ? { status: sanitizeProjectionDurableValue(payload.status) } : {}),
  };
  const sanitizedActor = sanitizeProjectionDurableValue(actor);
  const eventPayload = {
    ...sanitizedPayload,
    artifact_ref,
    actor: sanitizedActor,
    recorded_at,
  };
  const eventPayloadDecision = validateProjectionPayload(eventPayload, { type: eventType });
  if (!eventPayloadDecision.ok) throw new Error(eventPayloadDecision.error);
  if (eventType === "projection.result_recorded" && isSuccessfulProjectionResultStatus(eventPayload.status)) {
    const semanticDecision = validateProjectionResultPayload(eventPayload, { snapshot, durableContract: true });
    if (!semanticDecision.ok) throw new Error(semanticDecision.error);
  }

  const priorEvents = await readEventsByIdempotency(paths.eventsPath, eventType, payload.idempotency_key);
  if (priorEvents.length > 0) {
    const matchingEvent = priorEvents.find((event) => samePayload(event.evidence || {}, eventPayload))
      || priorEvents.find((event) => event?.evidence?.artifact_ref?.path === artifact_ref.path && event?.evidence?.artifact_ref?.sha256 === artifact_ref.sha256);
    const replayEvent = matchingEvent || priorEvents[0];

    const replayPayload = replayEvent.evidence || eventPayload;
    const replayArtifactRef = replayPayload.artifact_ref || artifact_ref;
    const existingReplayArtifact = await readArtifactIfExists(resolved.absolutePath);
    if (!existingReplayArtifact.exists) throw new Error(`artifact path ${resolved.relativePath} is missing for recorded projection event`);
    if (existingReplayArtifact.sha256 !== replayArtifactRef.sha256) {
      throw new Error(`artifact path ${resolved.relativePath} already exists with different hash`);
    }

    const repairedSnapshot = mergeProjectionSnapshot(snapshot, { ...replayPayload, type: eventType }, replayEvent.sequence);
    if (!samePayload(repairedSnapshot, snapshot)) {
      await writeJsonAtomic(paths.runPath, repairedSnapshot);
    }
    return {
      status: "noop",
      run: repairedSnapshot,
      artifact_ref,
      event: replayEvent,
    };
  }

  const existingFile = await readArtifactIfExists(resolved.absolutePath);
  if (existingFile.exists && existingFile.sha256 !== artifact_ref.sha256) {
    throw new Error(`artifact path ${resolved.relativePath} already exists with different hash`);
  }

  await writeTextAtomic(resolved.absolutePath, contentBuffer.toString("utf8"));
  const sequence = await nextSequence(paths, snapshot);
  const event = buildNonTransitionEvent({
    runId: snapshot.run_id,
    sequence,
    timestamp: recorded_at,
    type: eventType,
    actor: sanitizedActor,
    evidence: eventPayload,
    idempotencyKey: payload.idempotency_key,
  });
  const nextSnapshot = mergeProjectionSnapshot(snapshot, { ...eventPayload, type: eventType }, sequence);
  await appendJsonLine(paths.eventsPath, event);
  await writeJsonAtomic(paths.runPath, nextSnapshot);
  return {
    status: "recorded",
    run: nextSnapshot,
    artifact_ref,
    event,
  };
}

/**
 * Reads and parses a run snapshot from disk.
 *
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readRunSnapshot(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * Creates a batch snapshot from packet reports and accepted run snapshots.
 *
 * @param {Record<string, unknown>[]} reports
 * @param {Record<string, unknown>[]} runs
 * @param {{ registryRoot: string, createdAt: string }} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function createBatchFromPacketReports(reports, runs, { registryRoot, createdAt }) {
  if (!registryRoot) throw new Error("registryRoot is required");
  if (!createdAt) throw new Error("createdAt is required");

  const paths = getRegistryPaths(registryRoot);
  const batchId = buildBatchId(reports, createdAt, sha256Hex, canonicalJson);
  const batchDir = path.join(paths.batches, batchId);
  const batchPath = path.join(batchDir, "batch.json");
  const snapshot = buildBatchSnapshot(reports, runs, { registryRoot, createdAt, batchId });

  await writeJsonAtomic(batchPath, snapshot);
  return {
    batch_id: batchId,
    batch_dir: batchDir,
    batch_path: batchPath,
    selected_count: snapshot.selected.count,
    accepted_count: snapshot.accepted.count,
    blocked_count: snapshot.blocked.count,
  };
}

/**
 * Persists a full run snapshot to its canonical run.json path.
 *
 * @param {string} registryRoot
 * @param {Record<string, unknown>} snapshot
 * @returns {Promise<Record<string, unknown>>}
 */
export async function writeRunSnapshot(registryRoot, snapshot) {
  if (!registryRoot) throw new Error("registryRoot is required");
  if (!snapshot?.run_id) throw new Error("run snapshot with run_id is required");
  const paths = getRunPaths(registryRoot, snapshot.run_id);
  await writeJsonAtomic(paths.runPath, snapshot);
  return snapshot;
}

/**
 * Persists a JSON report file atomically.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<{ path: string }>}
 */
export async function writeRegistryReport(filePath, value) {
  await writeJsonAtomic(filePath, value);
  return { path: filePath };
}

/**
 * Commits a transition event and its resulting run snapshot.
 *
 * @param {string} runDir
 * @param {Record<string, unknown>} snapshot
 * @param {{ toState: string, actor?: string, evidence?: Record<string, unknown>, clock?: () => Date }} options
 * @returns {Promise<{ run: Record<string, unknown>, event: Record<string, unknown> }>}
 */
export async function commitRunTransition(runDir, snapshot, { toState, actor = "transition-engine", evidence = {}, clock = () => new Date() }) {
  if (!runDir) throw new Error("runDir is required");
  const runPath = path.join(runDir, "run.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const timestamp = clock().toISOString();
  const sequence = (await lastEventSequence(eventsPath)) + 1;
  const nextSnapshot = applyTransitionToSnapshot(snapshot, { toState, timestamp, evidence, sequence });
  const event = buildTransitionEvent({
    runId: snapshot.run_id,
    sequence,
    timestamp,
    fromState: snapshot.state,
    toState,
    actor,
    evidence,
  });
  await appendJsonLine(eventsPath, event);
  await writeJsonAtomic(runPath, nextSnapshot);
  return { run: nextSnapshot, event };
}

/**
 * Loads a run, commits a transition, and refreshes derived indexes.
 *
 * Terminal transitions also remove lease record files and append a lease-release event.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function transitionRun(registryRoot, runId, options = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const result = await commitRunTransition(paths.runDir, snapshot, options);
  let removedLeaseRecords = [];

  if (TERMINAL_STATES.has(result.run.state)) {
    removedLeaseRecords = await removeLeaseRecordsForRun(registryRoot, result.run);
    if (removedLeaseRecords.length > 0) {
      const releaseEvent = await appendRunEvent(paths.runDir, runId, {
        type: "lock.lease_released",
        actor: options.actor || "transition-engine",
        evidence: { reason: "terminal transition released lease records", removed_lease_records: removedLeaseRecords.length },
        clock: options.clock || (() => new Date()),
        idempotencyKey: `${runId}:terminal_lease_released:${result.event.sequence}`,
      });
      result.run = {
        ...result.run,
        last_sequence: releaseEvent.sequence,
        updated_at: releaseEvent.timestamp,
      };
      await writeJsonAtomic(paths.runPath, result.run);
    }
  }

  await rebuildIndexes(registryRoot, { clock: options.clock || (() => new Date()) });
  return {
    ...result,
    removed_lease_records: removedLeaseRecords,
  };
}

/**
 * Creates the initial run directory, packet artifact, transition journal, and queued/blocked state.
 *
 * @param {Record<string, unknown>} report
 * @param {{ registryRoot: string, clock?: () => Date, actor?: string }} input
 * @returns {Promise<{ run: Record<string, unknown>, run_dir: string, events: Record<string, unknown>[] }>}
 */
export async function createRunFromPacketReport(report, { registryRoot, clock = () => new Date(), actor = "packet-intake" }) {
  if (!registryRoot) throw new Error("registryRoot is required");
  if (!report?.run_id) throw new Error("packet report with run_id is required");

  const paths = getRunPaths(registryRoot, report.run_id);
  const packetArtifactPath = path.join(paths.artifactsDir, "packet.md");
  try {
    await fs.access(paths.runPath);
    throw new Error(`run already exists: ${report.run_id}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const createdAt = clock().toISOString();
  const packetArtifactContent = [
    "# Approved packet snapshot",
    "",
    `Schema: ${SCHEMA_VERSION}`,
    `Packet hash: ${report.packet_hash || ""}`,
    "",
    "```json",
    JSON.stringify(report.raw, null, 2),
    "```",
    "",
  ].join("\n");

  await writeTextAtomic(packetArtifactPath, packetArtifactContent);
  const packetReference = artifactRef(paths.runDir, packetArtifactPath, packetArtifactContent);
  let snapshot = buildInitialRunSnapshot(report, { createdAt, packetArtifactRef: packetReference });
  const receivedEvent = buildTransitionEvent({
    runId: report.run_id,
    sequence: 1,
    timestamp: createdAt,
    fromState: null,
    toState: "packet_received",
    actor,
    evidence: {
      packet_hash: report.packet_hash || "",
      packet_artifact: packetReference,
    },
    idempotencyKey: `${report.run_id}:packet_received:1`,
  });

  await writeTextAtomic(paths.eventsPath, "");
  await appendJsonLine(paths.eventsPath, receivedEvent);
  await writeJsonAtomic(paths.runPath, snapshot);

  const finalState = report.sufficient ? "queued" : "blocked_plan_insufficient";
  const committed = await commitRunTransition(paths.runDir, snapshot, {
    toState: finalState,
    actor,
    evidence: {
      sufficiency_status: report.sufficiency_status,
      missing_fields: report.missing_fields,
      reason: report.sufficient ? "Packet sufficiency passed" : `Packet insufficient: ${report.missing_fields.join(", ")}`,
    },
    clock,
  });
  snapshot = committed.run;
  await rebuildIndexes(registryRoot, { clock });

  return { run: snapshot, run_dir: paths.runDir, events: [receivedEvent, committed.event] };
}

/**
 * Records an immutable artifact under artifacts/ and updates the snapshot journalically.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @param {{ artifactPath: string, content: string | Buffer, gate_name: string, execution_epoch: number, gate_attempt: number, recorded_from_state: string, actor?: string, recorded_at?: string, provenance?: Record<string, unknown> }} payload
 * @returns {Promise<Record<string, unknown>>}
 */
export async function recordArtifact(registryRoot, runId, {
  artifactPath,
  content,
  gate_name,
  execution_epoch,
  gate_attempt,
  recorded_from_state,
  actor = "registry",
  recorded_at = new Date().toISOString(),
  provenance = {},
  } = {}) {
  const payload = {
    path: artifactPath,
    sha256: "",
    bytes: 0,
    gate_name,
    execution_epoch,
    gate_attempt,
    recorded_from_state,
    recorded_at,
    actor,
    provenance: isRecordLike(provenance) ? provenance : {},
  };
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const resolved = resolveArtifactPath(paths.runDir, artifactPath);
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  payload.path = resolved.relativePath;
  payload.sha256 = sha256Hex(contentBuffer);
  payload.bytes = contentBuffer.byteLength;
  const payloadDecision = validateArtifactRecordedPayload(payload);
  if (!payloadDecision.ok) throw new Error(payloadDecision.error);

  const priorEvents = await readArtifactRecordedEventsByPath(paths.eventsPath, payload.path);
  if (priorEvents.length > 0) {
    const matchingEvent = priorEvents.find((event) => sameArtifactRecordedPayload(event.evidence || {}, payload));
    if (!matchingEvent) {
      const conflictingPayload = priorEvents[0]?.evidence || {};
      if (conflictingPayload.sha256 && conflictingPayload.sha256 !== payload.sha256) {
        throw new Error(`artifact path ${resolved.relativePath} already recorded with different hash`);
      }
      throw new Error(`artifact path ${resolved.relativePath} already recorded with different payload`);
    }

    await verifyOrRecoverArtifactFile(resolved, contentBuffer, payload.sha256);

    const repairedSnapshot = mergeArtifactSummary(snapshot, buildRecordedArtifactSummary(matchingEvent.evidence), matchingEvent.sequence);
    if (!samePayload(repairedSnapshot, snapshot)) {
      await writeJsonAtomic(paths.runPath, repairedSnapshot);
    }
    return {
      status: "noop",
      run: repairedSnapshot,
      artifact_ref: { path: resolved.relativePath, sha256: payload.sha256 },
      event: matchingEvent,
    };
  }

  ensureArtifactWritePhase(snapshot, {
    gateName: gate_name,
    executionEpoch: execution_epoch,
    gateAttempt: gate_attempt,
    recordedFromState: recorded_from_state,
    kind: "artifact.recorded",
  });

  const existingSummary = snapshot.artifacts?.recorded?.by_path?.[resolved.relativePath];
  if (existingSummary) {
    const summaryPayload = buildRecordedArtifactSummary(payload);
    if (sameArtifactRecordedPayload(existingSummary, summaryPayload)) {
      await verifyOrRecoverArtifactFile(resolved, contentBuffer, payload.sha256);
      return { status: "noop", run: snapshot, artifact_ref: { path: resolved.relativePath, sha256: payload.sha256 }, event: null };
    }
    if (existingSummary.sha256 !== payload.sha256) throw new Error(`artifact path ${resolved.relativePath} already recorded with different hash`);
    throw new Error(`artifact path ${resolved.relativePath} already recorded with different payload`);
  }

  const existingFile = await readArtifactIfExists(resolved.absolutePath);
  if (existingFile.exists && existingFile.sha256 !== payload.sha256) {
    throw new Error(`artifact path ${resolved.relativePath} already exists with different hash`);
  }

  await writeTextAtomic(resolved.absolutePath, contentBuffer.toString("utf8"));
  const sequence = await nextSequence(paths, snapshot);
  const event = buildNonTransitionEvent({
    runId: snapshot.run_id,
    sequence,
    timestamp: payload.recorded_at,
    type: "artifact.recorded",
    actor: payload.actor,
    evidence: payload,
    idempotencyKey: `${snapshot.run_id}:artifact.recorded:${payload.path}:${payload.sha256}`,
  });
  const nextSnapshot = withArtifactRecordedSnapshot(snapshot, buildRecordedArtifactSummary(payload), sequence);
  await appendJsonLine(paths.eventsPath, event);
  await writeJsonAtomic(paths.runPath, nextSnapshot);
  return {
    status: "recorded",
    run: nextSnapshot,
    artifact_ref: { path: payload.path, sha256: payload.sha256 },
    event,
  };
}

/**
 * Records a resolved gate result and updates the corresponding gate head.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @param {Record<string, unknown>} [payload={}]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function recordGateResult(registryRoot, runId, payload = {}) {
  const payloadDecision = validateGateResultPayload(payload);
  if (!payloadDecision.ok) throw new Error(payloadDecision.error);
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);

  const priorEvents = await readEventsByIdempotency(paths.eventsPath, "gate.result_recorded", payload.idempotency_key);
  if (priorEvents.length > 0) {
    const existingPayload = priorEvents[0].evidence || {};
    if (samePayload(existingPayload, payload)) {
      return { status: "noop", run: snapshot, event: priorEvents[0] };
    }
    throw new Error(`gate result idempotency key ${payload.idempotency_key} conflicts with an existing payload`);
  }

  ensureArtifactWritePhase(snapshot, {
    gateName: payload.gate_name,
    executionEpoch: payload.execution_epoch,
    gateAttempt: payload.gate_attempt,
    recordedFromState: payload.recorded_from_state,
    kind: "gate.result_recorded",
  });
  assertArtifactRefsAvailable(snapshot, payload);

  const sequence = await nextSequence(paths, snapshot);
  const event = buildNonTransitionEvent({
    runId: snapshot.run_id,
    sequence,
    timestamp: payload.recorded_at,
    type: "gate.result_recorded",
    actor: payload.actor,
    evidence: payload,
    idempotencyKey: payload.idempotency_key,
  });
  const nextSnapshot = withGateResultSnapshot(snapshot, buildGateResultSummary(payload), sequence);
  await appendJsonLine(paths.eventsPath, event);
  await writeJsonAtomic(paths.runPath, nextSnapshot);
  return { status: "recorded", run: nextSnapshot, event };
}

/**
 * Records a projection intent from the handoff-ready stage.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @param {Record<string, unknown>} [payload={}]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function recordProjectionIntent(registryRoot, runId, payload = {}) {
  return recordProjectionEvent(registryRoot, runId, {
    ...payload,
    type: "projection.intent_recorded",
  });
}

/**
 * Records a projection result after its matching projection intent exists.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @param {Record<string, unknown>} [payload={}]
 * @returns {Promise<Record<string, unknown>>}
 * @throws {Error}
 */
export async function recordProjectionResult(registryRoot, runId, payload = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const intentEvents = await readEventsByIdempotency(paths.eventsPath, "projection.intent_recorded", payload.intent_idempotency_key);
  if (intentEvents.length === 0) {
    throw new Error(`projection.result_recorded requires a prior projection.intent_recorded event for ${payload.intent_idempotency_key}`);
  }
  return recordProjectionEvent(registryRoot, runId, {
    ...payload,
    type: "projection.result_recorded",
  });
}

function workerTaskSlice(snapshot) {
  return isRecord(snapshot.worker_tasks) ? snapshot.worker_tasks : { head: null, history: [] };
}

function appendWorkerTaskHistory(snapshot, head) {
  const slice = workerTaskSlice(snapshot);
  return head ? [...(Array.isArray(slice.history) ? slice.history : []), head] : (Array.isArray(slice.history) ? slice.history : []);
}

function appendDistinctWorkerTaskHistory(snapshot, head) {
  const history = appendWorkerTaskHistory(snapshot, null);
  return head && !history.some((entry) => samePayload(entry, head)) ? [...history, head] : history;
}

function observedCompletionHead(currentHead, completion, decision = "late") {
  return currentHead ? {
    ...currentHead,
    status: decision,
    completion,
    decision: {
      decision,
      reason: `observed ${decision} worker completion`,
      decided_at: completion.received_at,
      idempotency_key: completion.idempotency_key,
    },
    updated_at: completion.received_at,
  } : null;
}

export function withWorkerTaskCreatedSnapshot(snapshot, head, sequence) {
  const previousHead = snapshot.worker_tasks?.head || null;
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: head.updated_at,
    worker_tasks: { head, history: appendDistinctWorkerTaskHistory(snapshot, previousHead) },
  };
}

export function withWorkerTaskDispatchSnapshot(snapshot, head, sequence) {
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: head.updated_at,
    worker_tasks: { head, history: appendWorkerTaskHistory(snapshot, head) },
  };
}

export function withWorkerCompletionSnapshot(snapshot, completion, sequence) {
  const currentHead = snapshot.worker_tasks?.head || null;
  const evaluated = evaluateWorkerCompletion(currentHead, completion, { now: completion.received_at });
  const mutates = completionDecisionMutatesCurrentTruth(evaluated.decision);
  const head = mutates && currentHead ? { ...currentHead, status: "completion_received", completion, updated_at: completion.received_at } : currentHead;
  const history = mutates ? appendWorkerTaskHistory(snapshot, head) : appendWorkerTaskHistory(snapshot, observedCompletionHead(currentHead, completion, evaluated.decision));
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: completion.received_at,
    worker_tasks: { head, history },
  };
}

export function withWorkerCompletionDecisionSnapshot(snapshot, head, sequence) {
  const currentHead = snapshot.worker_tasks?.head || null;
  const mutates = !currentHead || !head ? false : !samePayload(currentHead, head);
  return {
    ...snapshot,
    last_sequence: sequence,
    updated_at: head?.updated_at || currentHead?.updated_at || snapshot.updated_at,
    worker_tasks: { head: mutates ? head : currentHead, history: mutates ? appendWorkerTaskHistory(snapshot, head) : appendWorkerTaskHistory(snapshot, null) },
  };
}

export function withWorkerTaskQuarantineSnapshot(snapshot, head, sequence) {
  return withWorkerCompletionDecisionSnapshot(snapshot, head, sequence);
}

async function recordWorkerTaskEvent(registryRoot, runId, { type, payload, actor = "registry", timestamp = "", idempotencyKey = "", mergeSnapshot }) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const eventTimestamp = nonEmptyString(timestamp) || payload.recorded_at || payload.received_at || payload.decided_at || new Date().toISOString();
  const eventKey = nonEmptyString(idempotencyKey) || nonEmptyString(payload.idempotency_key) || `${runId}:${type}:${payload.worker_task_id}:${eventTimestamp}`;
  const priorEvents = await readEventsByIdempotency(paths.eventsPath, type, eventKey);
  if (priorEvents.length > 0) {
    const existingPayload = priorEvents[0].evidence || {};
    if (!samePayload(existingPayload, payload) && !sameIdempotentWorkerTaskPayload(existingPayload, payload)) throw new Error(`${type} idempotency key ${eventKey} conflicts with an existing payload`);
    const repairedSnapshot = mergeSnapshot(snapshot, priorEvents[0].sequence, existingPayload);
    if (!samePayload(repairedSnapshot, snapshot)) await writeJsonAtomic(paths.runPath, repairedSnapshot);
    return { status: "noop", run: repairedSnapshot, event: priorEvents[0] };
  }
  const sequence = await nextSequence(paths, snapshot);
  const event = buildNonTransitionEvent({ runId, sequence, timestamp: eventTimestamp, type, actor, evidence: payload, idempotencyKey: eventKey });
  const nextSnapshot = mergeSnapshot(snapshot, sequence, payload);
  await appendJsonLine(paths.eventsPath, event);
  await writeJsonAtomic(paths.runPath, nextSnapshot);
  return { status: "recorded", run: nextSnapshot, event };
}

export async function recordWorkerTaskCreated(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const head = createWorkerTask({
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    purpose: input.purpose,
    role: input.role,
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : snapshot.execution?.current_epoch || 0,
    attempt: input.attempt || 1,
    authority: input.authority,
    deadline_at: input.deadline_at ?? null,
    created_at: input.recorded_at || input.created_at || new Date().toISOString(),
  });
  const payload = {
    worker_task_id: head.worker_task_id,
    run_id: head.run_id,
    task_id: head.task_id,
    purpose: head.purpose,
    role: head.role,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: head.status,
    deadline_at: head.deadline_at,
    recorded_at: head.created_at,
    idempotency_key: input.idempotency_key || `${head.worker_task_id}:created`,
  };
  const decision = validateWorkerTaskEventPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.created",
    payload,
    actor: input.actor || "registry",
    timestamp: payload.recorded_at,
    idempotencyKey: payload.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerTaskCreatedSnapshot(snap, head, sequence),
  });
}

export async function recordWorkerTaskDispatch(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  if (!isRecord(snapshot.worker_tasks?.head)) throw new Error("worker_task.dispatch_recorded requires worker_tasks.head");
  const head = recordWorkerTaskDispatchCore(snapshot.worker_tasks.head, {
    intent_ref: input.intent_ref,
    dispatch_ref: input.dispatch_ref,
    idempotency_key: input.idempotency_key,
    recorded_at: input.recorded_at || new Date().toISOString(),
  });
  const payload = {
    worker_task_id: head.worker_task_id,
    run_id: head.run_id,
    task_id: head.task_id,
    purpose: head.purpose,
    role: head.role,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: head.status,
    deadline_at: head.deadline_at,
    recorded_at: head.updated_at,
    idempotency_key: input.idempotency_key || `${head.worker_task_id}:dispatch`,
    intent_ref: input.intent_ref || null,
    dispatch_ref: input.dispatch_ref || null,
  };
  const decision = validateWorkerTaskEventPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.dispatch_recorded",
    payload,
    actor: input.actor || "registry",
    timestamp: payload.recorded_at,
    idempotencyKey: payload.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerTaskDispatchSnapshot(snap, head, sequence),
  });
}

export async function recordWorkerCompletion(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const currentHead = snapshot.worker_tasks?.head || {};
  const completion = normalizeWorkerCompletion({
    worker_task_id: Object.prototype.hasOwnProperty.call(input, "worker_task_id") ? input.worker_task_id : currentHead.worker_task_id,
    run_id: input.run_id || snapshot.run_id,
    task_id: input.task_id || snapshot.task_id,
    purpose: input.purpose || currentHead.purpose,
    role: input.role || (input.purpose ? undefined : currentHead.role),
    epoch: Number.isSafeInteger(input.epoch) ? input.epoch : currentHead.epoch,
    attempt: input.attempt || currentHead.attempt,
    authority: input.authority || currentHead.authority,
    status: input.status,
    completion_ref: input.completion_ref,
    evidence: input.evidence,
    idempotency_key: input.idempotency_key,
    received_at: input.received_at || input.recorded_at || new Date().toISOString(),
  });
  const payload = { ...completion, evidence_refs: Object.values(completion.evidence || {}).flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => isRecord(value) && value.path && value.sha256) };
  const decision = validateWorkerCompletionPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.completion_received",
    payload,
    actor: input.actor || completion.authority,
    timestamp: completion.received_at,
    idempotencyKey: completion.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerCompletionSnapshot(snap, completion, sequence),
  });
}

export async function recordWorkerCompletionDecision(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  if (!isRecord(snapshot.worker_tasks?.head)) throw new Error("worker_task.completion_decided requires worker_tasks.head");
  const completionInput = input.completion || snapshot.worker_tasks.head.completion || {};
  const completion = normalizeWorkerCompletion({
    worker_task_id: completionInput.worker_task_id || snapshot.worker_tasks.head.worker_task_id,
    run_id: completionInput.run_id || snapshot.run_id,
    task_id: completionInput.task_id || snapshot.task_id,
    purpose: completionInput.purpose || snapshot.worker_tasks.head.purpose,
    role: completionInput.role || (completionInput.purpose ? undefined : snapshot.worker_tasks.head.role),
    epoch: Number.isSafeInteger(completionInput.epoch) ? completionInput.epoch : snapshot.worker_tasks.head.epoch,
    attempt: completionInput.attempt || snapshot.worker_tasks.head.attempt,
    authority: completionInput.authority || snapshot.worker_tasks.head.authority,
    status: completionInput.status,
    completion_ref: completionInput.completion_ref,
    evidence: completionInput.evidence,
    idempotency_key: completionInput.idempotency_key,
    received_at: completionInput.received_at || completionInput.recorded_at || snapshot.worker_tasks.head.completion?.received_at,
  });
  const evaluated = evaluateWorkerCompletion(snapshot.worker_tasks.head, completion, { now: input.decided_at || new Date().toISOString() });
  const callerForcedAccepted = String(input.decision || "").toLowerCase() === "accepted";
  const effectiveDecision = input.decision && !callerForcedAccepted
    ? { decision: input.decision, reason: input.reason || "completion decision recorded", decided_at: input.decided_at || new Date().toISOString() }
    : evaluated;
  const normalizedDecision = {
    ...effectiveDecision,
    idempotency_key: input.idempotency_key || `${completion.idempotency_key}:decision`,
  };
  const head = applyCompletionDecisionToWorkerTask(snapshot.worker_tasks.head, completion, normalizedDecision);
  const payload = {
    worker_task_id: completion.worker_task_id || snapshot.worker_tasks.head.worker_task_id,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    purpose: completion.purpose || snapshot.worker_tasks.head.purpose,
    role: completion.role || snapshot.worker_tasks.head.role,
    completion_status: completion.status,
    decision: normalizedDecision.decision,
    reason: normalizedDecision.reason,
    decided_at: normalizedDecision.decided_at,
    idempotency_key: normalizedDecision.idempotency_key,
    completion_idempotency_key: completion.idempotency_key,
  };
  const decision = validateCompletionDecisionPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.completion_decided",
    payload,
    actor: input.actor || "registry",
    timestamp: payload.decided_at,
    idempotencyKey: payload.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerCompletionDecisionSnapshot(snap, head, sequence),
  });
}

export async function recordWorkerTaskOverdue(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  if (!isRecord(snapshot.worker_tasks?.head)) throw new Error("worker_task.overdue_recorded requires worker_tasks.head");
  const head = markWorkerTaskOverdue(snapshot.worker_tasks.head, input);
  const payload = {
    worker_task_id: head.worker_task_id,
    run_id: head.run_id,
    task_id: head.task_id,
    purpose: head.purpose,
    role: head.role,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: head.status,
    deadline_at: head.deadline_at,
    recorded_at: head.updated_at,
    idempotency_key: input.idempotency_key || `${head.worker_task_id}:overdue`,
    reason: input.reason || "worker task deadline passed",
  };
  const decision = validateWorkerTaskEventPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.overdue_recorded",
    payload,
    actor: input.actor || "registry",
    timestamp: payload.recorded_at,
    idempotencyKey: payload.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerCompletionDecisionSnapshot(snap, head, sequence),
  });
}

export async function quarantineWorkerTaskRun(registryRoot, runId, input = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  if (!isRecord(snapshot.worker_tasks?.head)) throw new Error("worker_task.quarantined requires worker_tasks.head");
  const head = quarantineWorkerTask(snapshot.worker_tasks.head, input);
  const payload = {
    worker_task_id: head.worker_task_id,
    run_id: head.run_id,
    task_id: head.task_id,
    purpose: head.purpose,
    role: head.role,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: head.status,
    deadline_at: head.deadline_at,
    recorded_at: head.updated_at,
    idempotency_key: input.idempotency_key || `${head.worker_task_id}:quarantine`,
    reason: input.reason || "worker task requires human review",
  };
  const decision = validateWorkerTaskEventPayload(payload);
  if (!decision.ok) throw new Error(decision.error);
  return recordWorkerTaskEvent(registryRoot, runId, {
    type: "worker_task.quarantined",
    payload,
    actor: input.actor || "registry",
    timestamp: payload.recorded_at,
    idempotencyKey: payload.idempotency_key,
    mergeSnapshot: (snap, sequence) => withWorkerTaskQuarantineSnapshot(snap, head, sequence),
  });
}

export { quarantineWorkerTaskRun as quarantineWorkerTask, deriveWorkerTaskSummary };
