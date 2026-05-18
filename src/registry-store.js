import { promises as fs } from "node:fs";
import path from "node:path";

import { ARTIFACT_STAGE_STATE_BY_NAME, GATE_STATE_BY_NAME, GATE_STATUS, SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
import {
  buildBatchId,
  buildBatchSnapshot,
  buildGateResultSummary,
  buildInitialRunSnapshot,
  buildRecordedArtifactSummary,
  validateArtifactRecordedPayload,
  validateGateResultPayload,
  validateProjectionResultPayload,
} from "./execution-run-schema.js";
import { appendJsonLine, writeJsonAtomic, writeTextAtomic } from "./fs-atomic.js";
import { isSuccessfulProjectionResultStatus, mergeProjectionSnapshot, sanitizeProjectionDurableValue } from "./projection-contract.js";
import { applyTransitionToSnapshot, buildNonTransitionEvent, buildTransitionEvent, isKnownState } from "./state-machine.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "./utils.js";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
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

async function lastEventSequence(eventsPath) {
  try {
    const events = await readEventsFile(eventsPath);
    return events.reduce((max, event) => Math.max(max, Number.isSafeInteger(event.sequence) ? event.sequence : 0), 0);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function nextSequence(paths, snapshot) {
  const journalSequence = await lastEventSequence(paths.eventsPath);
  const snapshotSequence = Number.isSafeInteger(snapshot?.last_sequence) ? snapshot.last_sequence : 0;
  return Math.max(journalSequence, snapshotSequence) + 1;
}

async function readEventsByIdempotency(eventsPath, type, idempotencyKey) {
  if (!nonEmptyString(idempotencyKey)) return [];
  const events = await readEventsFile(eventsPath).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return events.filter((event) => event.type === type && event.idempotency_key === idempotencyKey);
}

async function readArtifactRecordedEventsByPath(eventsPath, artifactPath) {
  if (!nonEmptyString(artifactPath)) return [];
  const events = await readEventsFile(eventsPath).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return events.filter((event) => event.type === "artifact.recorded" && event.evidence?.path === artifactPath);
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
  if (payload?.recorded_from_state !== "pr_ready") errors.push("recorded_from_state must be pr_ready");
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
  if (snapshot.state !== "pr_ready") throw new Error(`${type} requires state pr_ready; current state: ${snapshot.state}`);
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
    ...(hasOwn(payload, "github_pr") ? { github_pr: sanitizeProjectionDurableValue(payload.github_pr) } : {}),
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
    const matchingEvent = priorEvents.find((event) => samePayload(event.evidence || {}, eventPayload));
    if (!matchingEvent) throw new Error(`${eventType} idempotency key ${payload.idempotency_key} conflicts with an existing payload`);

    await verifyOrRecoverArtifactFile(resolved, contentBuffer, artifact_ref.sha256);

    const repairedSnapshot = mergeProjectionSnapshot(snapshot, { ...eventPayload, type: eventType }, matchingEvent.sequence);
    if (!samePayload(repairedSnapshot, snapshot)) {
      await writeJsonAtomic(paths.runPath, repairedSnapshot);
    }
    return {
      status: "noop",
      run: repairedSnapshot,
      artifact_ref,
      event: matchingEvent,
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

export async function readRunSnapshot(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function readEventsFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.trim()) return [];
  return raw.trimEnd().split("\n").map((line) => JSON.parse(line));
}

export function getRegistryPaths(registryRoot) {
  return {
    root: registryRoot,
    runs: path.join(registryRoot, "runs"),
    batches: path.join(registryRoot, "batches"),
    indexes: path.join(registryRoot, "indexes"),
    quarantine: path.join(registryRoot, "quarantine"),
    activeRuns: path.join(registryRoot, "indexes", "active-runs.json"),
    workspaceLeases: path.join(registryRoot, "indexes", "workspace-leases.json"),
  };
}

export function getRunPaths(registryRoot, runId) {
  const runDir = path.join(getRegistryPaths(registryRoot).runs, runId);
  return {
    runDir,
    runPath: path.join(runDir, "run.json"),
    eventsPath: path.join(runDir, "events.jsonl"),
    artifactsDir: path.join(runDir, "artifacts"),
  };
}

function leaseRecordsDir(registryRoot) {
  return path.join(registryRoot, "leases");
}

export async function removeLeaseRecordsForRun(registryRoot, snapshot) {
  const leasesDir = leaseRecordsDir(registryRoot);
  const entries = await fs.readdir(leasesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const leaseIds = new Set([snapshot.workspace?.lease_id, snapshot.locks?.lease_id].filter((value) => typeof value === "string" && value.trim()));
  const removed = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const recordPath = path.join(leasesDir, entry.name);
    let record;
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      continue;
    }
    if (record?.run_id !== snapshot.run_id) continue;
    if (leaseIds.size > 0 && record.lease_id && !leaseIds.has(record.lease_id)) continue;
    await fs.rm(recordPath, { force: true });
    removed.push(recordPath);
  }

  return removed.sort((a, b) => a.localeCompare(b));
}

export async function removeLeaseRecordPath(recordPath) {
  await fs.rm(recordPath, { force: true });
  return recordPath;
}

export async function writeLeaseRecordExclusive(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: filePath, record };
}

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

export async function appendRunEvent(runDir, runId, { type, actor = "registry", evidence = {}, clock = () => new Date(), timestamp = "", idempotencyKey = "" } = {}) {
  if (!runDir) throw new Error("runDir is required");
  const eventsPath = path.join(runDir, "events.jsonl");
  const eventTimestamp = nonEmptyString(timestamp) || clock().toISOString();
  const sequence = await lastEventSequence(eventsPath) + 1;
  const event = buildNonTransitionEvent({
    runId,
    sequence,
    timestamp: eventTimestamp,
    type,
    actor,
    evidence,
    idempotencyKey,
  });
  await appendJsonLine(eventsPath, event);
  return event;
}

export async function writeRunSnapshot(registryRoot, snapshot) {
  if (!registryRoot) throw new Error("registryRoot is required");
  if (!snapshot?.run_id) throw new Error("run snapshot with run_id is required");
  const paths = getRunPaths(registryRoot, snapshot.run_id);
  await writeJsonAtomic(paths.runPath, snapshot);
  return snapshot;
}

export async function writeRegistryReport(filePath, value) {
  await writeJsonAtomic(filePath, value);
  return { path: filePath };
}

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

export async function recordProjectionIntent(registryRoot, runId, payload = {}) {
  return recordProjectionEvent(registryRoot, runId, {
    ...payload,
    type: "projection.intent_recorded",
  });
}

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

function isRecordLike(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function indexEntryFromSnapshot(snapshot) {
  return {
    run_id: snapshot.run_id,
    state: snapshot.state,
    repo: snapshot.github?.repo || "",
    issue_number: snapshot.github?.issue_number || null,
    branch: snapshot.github?.intended_branch || "",
  };
}

function leaseEntryFromSnapshot(snapshot) {
  if (snapshot.workspace?.lease_status !== "acquired" && snapshot.locks?.lease_status !== "acquired") return null;
  return {
    run_id: snapshot.run_id,
    state: snapshot.state,
    lease_id: snapshot.workspace?.lease_id || snapshot.locks?.lease_id || "",
    workspace_id: snapshot.workspace?.id || null,
    workspace_path: snapshot.workspace?.path || null,
    repo: snapshot.github?.repo || snapshot.locks?.repo || "",
    issue_number: snapshot.github?.issue_number || snapshot.locks?.issue || null,
    branch: snapshot.github?.intended_branch || snapshot.locks?.branch || "",
    conflict_surface: snapshot.locks?.conflict_surface || [],
    acquired_at: snapshot.workspace?.acquired_at || snapshot.locks?.acquired_at || "",
    expires_at: snapshot.workspace?.expires_at || snapshot.locks?.expires_at || "",
    lock_keys: snapshot.locks?.lock_keys || [],
  };
}

export async function rebuildIndexes(registryRoot, { clock = () => new Date(), snapshots = null } = {}) {
  const paths = getRegistryPaths(registryRoot);
  await fs.mkdir(paths.runs, { recursive: true });
  const sourceSnapshots = [];

  if (Array.isArray(snapshots)) {
    sourceSnapshots.push(...snapshots);
  } else {
    const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(paths.runs, entry.name, "run.json");
      try {
        const snapshot = await readRunSnapshot(runPath);
        if (snapshot?.schema_version !== SCHEMA_VERSION) continue;
        if (!isKnownState(snapshot.state)) continue;
        sourceSnapshots.push(snapshot);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  const runs = sourceSnapshots
    .filter((snapshot) => snapshot?.schema_version === SCHEMA_VERSION && isKnownState(snapshot.state) && !TERMINAL_STATES.has(snapshot.state))
    .map(indexEntryFromSnapshot)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
  const leases = sourceSnapshots
    .filter((snapshot) => snapshot?.schema_version === SCHEMA_VERSION && isKnownState(snapshot.state) && !TERMINAL_STATES.has(snapshot.state))
    .map(leaseEntryFromSnapshot)
    .filter(Boolean)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));

  const updatedAt = clock().toISOString();
  await writeJsonAtomic(paths.activeRuns, {
    schema_version: SCHEMA_VERSION,
    updated_at: updatedAt,
    runs,
  });
  await writeJsonAtomic(paths.workspaceLeases, {
    schema_version: SCHEMA_VERSION,
    updated_at: updatedAt,
    leases,
  });
  return { active_runs: runs, workspace_leases: leases };
}

export function hashRunSnapshot(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}
