import path from "node:path";

import { ARTIFACT_STAGE_STATE_BY_NAME, GATE_STATE_BY_NAME, GATE_STATUS, SCHEMA_VERSION, TERMINAL_STATES } from "../../core/modules/execution-runs/constants.js";
import {
  buildGateResultSummary,
  buildGateSummary,
  buildRecordedArtifactSummary,
  findArtifactRefs,
  validateArtifactRecordedEvent,
  validateGateResultRecordedEvent,
  validateProjectionIntentRecordedEvent,
  validateProjectionResultPayload,
  validateProjectionResultRecordedEvent,
  validateRunSnapshot,
} from "../schema/index.js";
import { assertRegistryRepository } from "../../core/modules/execution-runs/ports/registry-repository.js";
import { assertWorkspaceLeaseService } from "../../core/modules/workspace-leases/ports/workspace-lease-service.js";
import { assertRegistryRecoveryStore } from "./store.js";
import { applyTransitionToSnapshot, validateTransition, validateTransitionEvent } from "../../core/modules/execution-runs/state-machine.js";
import { isSuccessfulProjectionResultStatus } from "../../core/modules/scm-handoff/status.js";
import { canonicalJson, isRecord, sha256Hex } from "../../shared/primitives.js";
import { resolveContainedRelativePath } from "../../shared/safe-relative-path.js";

/**
 * Recovery-time registry inspection and quarantine pipeline.
 *
 * Responsibilities:
 * - validate persisted run snapshots and event journals by replaying them;
 * - verify artifact integrity and lease reconstruction preconditions;
 * - quarantine corrupt runs before rebuilding derived indexes.
 *
 * Non-goals:
 * - repairing malformed runs in place;
 * - initiating external side effects beyond local quarantine/index writes.
 */


function parseJsonLinesStrict(raw) {
  if (!raw.trim()) return { events: [], malformed: [] };
  const lines = raw.split("\n");
  const hasTrailingNewline = raw.endsWith("\n");
  const parseLines = hasTrailingNewline && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const events = [];
  const malformed = [];
  for (let index = 0; index < parseLines.length; index += 1) {
    const line = parseLines[index];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      malformed.push({ line_number: index + 1, reason: error?.message || String(error), trailing: index === parseLines.length - 1 && !hasTrailingNewline });
    }
  }
  return { events, malformed };
}

async function readEventsStrict(store, eventsPath) {
  const raw = await store.readRunEventsText({ eventsPath });
  return parseJsonLinesStrict(raw);
}

export async function verifyArtifactRefs(store, runDir, snapshot, events) {
  const refs = findArtifactRefs(snapshot).concat(findArtifactRefs(events));
  const unique = new Map();
  for (const ref of refs) unique.set(`${ref.path}:${ref.sha256}`, ref);
  const findings = [];
  for (const ref of unique.values()) {
    const resolved = resolveContainedRelativePath(runDir, ref.path);
    if (!resolved) {
      findings.push({ severity: "error", type: "artifact_path_escape", path: ref.path });
      continue;
    }
    try {
      const content = await store.readArtifactContent({ runDir, artifactPath: resolved.absolutePath, artifactRef: ref });
      const actual = sha256Hex(content);
      if (actual !== ref.sha256) {
        findings.push({ severity: "error", type: "artifact_hash_mismatch", path: ref.path, expected: ref.sha256, actual });
      }
    } catch (error) {
      findings.push({ severity: "error", type: "artifact_missing", path: ref.path, expected: ref.sha256, reason: error?.message || String(error) });
    }
  }
  return findings;
}

function replaySeed(snapshot) {
  return {
    run_id: snapshot.run_id,
    state: null,
    last_sequence: 0,
    scm_target: {
      provider: snapshot.scm_target?.provider || "",
      repo: snapshot.scm_target?.repo || "",
      issue_number: snapshot.scm_target?.issue_number ?? null,
      intended_branch: snapshot.scm_target?.intended_branch || "",
      base_branch: snapshot.scm_target?.base_branch || "",
    },
    handoff_target: null,
    execution: {
      current_epoch: 0,
    },
    gates: {
      verification: buildGateSummary(0),
      internal_review: buildGateSummary(0),
    },
    artifacts: {
      recorded: {
        by_path: {},
      },
    },
    projection_ledger: {},
  };
}

function compareSemanticSlice(snapshot, replay) {
  return canonicalJson({
    state: snapshot.state,
    last_sequence: snapshot.last_sequence,
    execution: snapshot.execution,
    gates: snapshot.gates,
    artifacts: snapshot.artifacts?.recorded || { by_path: {} },
    handoff_target: snapshot.handoff_target ?? null,
    projection_ledger: snapshot.projection_ledger || {},
  }) === canonicalJson({
    state: replay.state,
    last_sequence: replay.last_sequence,
    execution: replay.execution,
    gates: replay.gates,
    artifacts: replay.artifacts.recorded,
    handoff_target: replay.handoff_target ?? null,
    projection_ledger: replay.projection_ledger,
  });
}

function gateHead(snapshot, gateName) {
  return snapshot.gates?.[gateName] || buildGateSummary(snapshot.execution?.current_epoch || 0);
}

function expectedAttempt(snapshot, gateName) {
  return (gateHead(snapshot, gateName).current_attempt || 0) + 1;
}

function validateArtifactReplaySemantics(snapshot, payload) {
  const expectedState = ARTIFACT_STAGE_STATE_BY_NAME[payload.gate_name] || "";
  if (!expectedState || snapshot.state !== expectedState) return `artifact.recorded requires current state ${expectedState}; got ${snapshot.state}`;
  if (payload.recorded_from_state !== snapshot.state) return `artifact.recorded recorded_from_state ${payload.recorded_from_state} does not match current state ${snapshot.state}`;
  if (payload.execution_epoch !== snapshot.execution.current_epoch) return `artifact.recorded execution_epoch ${payload.execution_epoch} does not match current epoch ${snapshot.execution.current_epoch}`;
  if (!GATE_STATE_BY_NAME[payload.gate_name]) {
    if (payload.gate_attempt !== 1) return `artifact.recorded gate_attempt ${payload.gate_attempt} is stale or out of order; expected 1`;
    const existingArtifact = snapshot.artifacts.recorded.by_path[payload.path];
    if (existingArtifact) return `artifact.recorded reuses immutable path ${payload.path}`;
    return "";
  }
  if (payload.gate_attempt !== expectedAttempt(snapshot, payload.gate_name)) return `artifact.recorded gate_attempt ${payload.gate_attempt} is stale or out of order; expected ${expectedAttempt(snapshot, payload.gate_name)}`;
  const gate = gateHead(snapshot, payload.gate_name);
  if (gate.status !== GATE_STATUS.PENDING) return `artifact.recorded is not allowed after gate ${payload.gate_name} resolved with ${gate.status}`;
  const existing = snapshot.artifacts.recorded.by_path[payload.path];
  if (existing) return `artifact.recorded reuses immutable path ${payload.path}`;
  return "";
}

function validateGateReplaySemantics(snapshot, payload, idempotencyPayloads) {
  const expectedState = GATE_STATE_BY_NAME[payload.gate_name] || "";
  if (!expectedState || snapshot.state !== expectedState) return `gate.result_recorded requires current state ${expectedState}; got ${snapshot.state}`;
  if (payload.recorded_from_state !== snapshot.state) return `gate.result_recorded recorded_from_state ${payload.recorded_from_state} does not match current state ${snapshot.state}`;
  if (payload.execution_epoch !== snapshot.execution.current_epoch) return `gate.result_recorded execution_epoch ${payload.execution_epoch} does not match current epoch ${snapshot.execution.current_epoch}`;

  const payloadKey = payload.idempotency_key;
  const canonicalPayload = canonicalJson(payload);
  const priorPayload = idempotencyPayloads.get(payloadKey);
  if (priorPayload && priorPayload !== canonicalPayload) return `gate.result_recorded idempotency key ${payloadKey} conflicts with a different payload`;

  if (payload.gate_attempt !== expectedAttempt(snapshot, payload.gate_name)) return `gate.result_recorded gate_attempt ${payload.gate_attempt} is stale or out of order; expected ${expectedAttempt(snapshot, payload.gate_name)}`;
  const gate = gateHead(snapshot, payload.gate_name);
  if (gate.status !== GATE_STATUS.PENDING) return `gate.result_recorded is not allowed after gate ${payload.gate_name} resolved with ${gate.status}`;

  for (const ref of payload.artifact_refs) {
    const summary = snapshot.artifacts.recorded.by_path[ref.path];
    if (!summary) return `gate.result_recorded references missing artifact ${ref.path}`;
    if (summary.sha256 !== ref.sha256) return `gate.result_recorded references artifact ${ref.path} with mismatched hash`;
    if (summary.gate_name !== payload.gate_name) return `gate.result_recorded references artifact ${ref.path} from gate ${summary.gate_name}`;
    if (summary.execution_epoch !== payload.execution_epoch) return `gate.result_recorded references artifact ${ref.path} from epoch ${summary.execution_epoch}`;
    if (summary.gate_attempt !== payload.gate_attempt) return `gate.result_recorded references artifact ${ref.path} from attempt ${summary.gate_attempt}`;
  }
  return "";
}

function mergeProjectionSnapshot(snapshot, payload, sequence) {
  const currentProjection = isRecord(snapshot.projection_ledger?.handoff_target) ? snapshot.projection_ledger.handoff_target : {};
  const nextProjection = {
    projection_name: payload.projection_name,
    projection_target: payload.projection_target,
    adapter: payload.adapter,
    mode: payload.mode,
    execution_epoch: payload.execution_epoch,
    recorded_from_state: payload.recorded_from_state,
    ...(isRecord(currentProjection.last_intent) ? { last_intent: currentProjection.last_intent } : {}),
    ...(isRecord(currentProjection.last_result) ? { last_result: currentProjection.last_result } : {}),
  };
  if (payload.type === "projection.intent_recorded") {
    nextProjection.last_intent = {
      artifact_ref: payload.artifact_ref,
      recorded_at: payload.recorded_at,
      actor: payload.actor,
      idempotency_key: payload.idempotency_key,
      execution_epoch: payload.execution_epoch,
      recorded_from_state: payload.recorded_from_state,
      sequence,
    };
  } else {
    nextProjection.last_result = {
      status: payload.status,
      artifact_ref: payload.artifact_ref,
      recorded_at: payload.recorded_at,
      actor: payload.actor,
      idempotency_key: payload.idempotency_key,
      intent_idempotency_key: payload.intent_idempotency_key,
      execution_epoch: payload.execution_epoch,
      recorded_from_state: payload.recorded_from_state,
      handoff_target: payload.handoff_target,
      sequence,
    };
  }
  const nextSnapshot = {
    ...snapshot,
    last_sequence: Math.max(Number.isSafeInteger(snapshot.last_sequence) ? snapshot.last_sequence : 0, sequence),
    updated_at: typeof snapshot.updated_at === "string" && snapshot.updated_at > payload.recorded_at ? snapshot.updated_at : payload.recorded_at,
    projection_ledger: {
      ...(snapshot.projection_ledger || {}),
      handoff_target: nextProjection,
    },
  };
  if (payload.type === "projection.result_recorded" && isSuccessfulProjectionResultStatus(payload.status)) {
    nextSnapshot.handoff_target = payload.handoff_target;
  }
  return nextSnapshot;
}

function projectionHead(snapshot) {
  return snapshot.projection_ledger?.handoff_target || null;
}

function validateProjectionIntentReplaySemantics(snapshot, payload, idempotencyPayloads) {
  if (snapshot.state !== "handoff_ready") return `projection.intent_recorded requires current state handoff_ready; got ${snapshot.state}`;
  if (payload.recorded_from_state !== snapshot.state) return `projection.intent_recorded recorded_from_state ${payload.recorded_from_state} does not match current state ${snapshot.state}`;
  if (payload.execution_epoch !== snapshot.execution.current_epoch) return `projection.intent_recorded execution_epoch ${payload.execution_epoch} does not match current epoch ${snapshot.execution.current_epoch}`;

  const payloadKey = payload.idempotency_key;
  const canonicalPayload = canonicalJson(payload);
  const priorPayload = idempotencyPayloads.get(payloadKey);
  if (priorPayload && priorPayload !== canonicalPayload) return `projection.intent_recorded idempotency key ${payloadKey} conflicts with a different payload`;

  const projection = projectionHead(snapshot);
  if (projection?.last_intent) return "projection.intent_recorded duplicated a current-epoch projection intent";
  return "";
}

function validateProjectionResultReplaySemantics(snapshot, payload, idempotencyPayloads) {
  if (snapshot.state !== "handoff_ready") return `projection.result_recorded requires current state handoff_ready; got ${snapshot.state}`;
  if (payload.recorded_from_state !== snapshot.state) return `projection.result_recorded recorded_from_state ${payload.recorded_from_state} does not match current state ${snapshot.state}`;
  if (payload.execution_epoch !== snapshot.execution.current_epoch) return `projection.result_recorded execution_epoch ${payload.execution_epoch} does not match current epoch ${snapshot.execution.current_epoch}`;

  const payloadKey = payload.idempotency_key;
  const canonicalPayload = canonicalJson(payload);
  const priorPayload = idempotencyPayloads.get(payloadKey);
  if (priorPayload && priorPayload !== canonicalPayload) return `projection.result_recorded idempotency key ${payloadKey} conflicts with a different payload`;

  const projection = projectionHead(snapshot);
  if (!projection?.last_intent) return "projection.result_recorded requires a prior projection.intent_recorded event";
  if (projection.last_intent.idempotency_key !== payload.intent_idempotency_key) {
    return `projection.result_recorded intent idempotency key ${payload.intent_idempotency_key} does not match the recorded projection intent ${projection.last_intent.idempotency_key}`;
  }
  if (projection?.last_result) return "projection.result_recorded duplicated a current-epoch projection result";

  const payloadDecision = validateProjectionResultPayload(payload, { fieldPath: "event.evidence", snapshot, durableContract: true });
  if (!payloadDecision.ok) return payloadDecision.error;
  return "";
}

function replayDomainEvents(events, runId, snapshot) {
  if (events.length === 0) return { ok: false, reason: "events.jsonl has no events" };
  const replay = replaySeed(snapshot);
  let expectedFromState = null;
  const idempotencyPayloads = new Map();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSequence = index + 1;
    if (event.type === "transition") {
      const decision = validateTransitionEvent(event, { expectedRunId: runId, expectedSequence, expectedFromState });
      if (!decision.ok) return { ok: false, reason: decision.reason };
      const semanticDecision = validateTransition({ fromState: replay.state, toState: event.state_after, snapshot: replay });
      if (!semanticDecision.ok) return { ok: false, reason: semanticDecision.reason };
      Object.assign(replay, applyTransitionToSnapshot(replay, {
        toState: event.state_after,
        timestamp: event.timestamp,
        evidence: event.evidence,
        sequence: event.sequence,
      }));
      expectedFromState = replay.state;
      continue;
    }

    const commonDecision = validateTransitionEvent(event, { expectedRunId: runId, expectedSequence, expectedFromState });
    if (!commonDecision.ok) return { ok: false, reason: commonDecision.reason };

    if (event.type === "artifact.recorded") {
      const typedDecision = validateArtifactRecordedEvent(event, { expectedRunId: runId, expectedSequence });
      if (!typedDecision.ok) return { ok: false, reason: typedDecision.error };
      const semanticError = validateArtifactReplaySemantics(replay, event.evidence);
      if (semanticError) return { ok: false, reason: semanticError };
      replay.artifacts.recorded.by_path[event.evidence.path] = buildRecordedArtifactSummary(event.evidence);
      replay.last_sequence = event.sequence;
      continue;
    }

    if (event.type === "gate.result_recorded") {
      const typedDecision = validateGateResultRecordedEvent(event, { expectedRunId: runId, expectedSequence });
      if (!typedDecision.ok) return { ok: false, reason: typedDecision.error };
      const semanticError = validateGateReplaySemantics(replay, event.evidence, idempotencyPayloads);
      if (semanticError) return { ok: false, reason: semanticError };
      idempotencyPayloads.set(event.evidence.idempotency_key, canonicalJson(event.evidence));
      replay.gates[event.evidence.gate_name] = buildGateResultSummary(event.evidence);
      replay.last_sequence = event.sequence;
      continue;
    }

    if (event.type === "projection.intent_recorded") {
      const typedDecision = validateProjectionIntentRecordedEvent(event, { expectedRunId: runId, expectedSequence });
      if (!typedDecision.ok) return { ok: false, reason: typedDecision.error };
      const semanticError = validateProjectionIntentReplaySemantics(replay, event.evidence, idempotencyPayloads);
      if (semanticError) return { ok: false, reason: semanticError };
      idempotencyPayloads.set(event.evidence.idempotency_key, canonicalJson(event.evidence));
      Object.assign(replay, mergeProjectionSnapshot(replay, { ...event.evidence, type: event.type }, event.sequence));
      continue;
    }

    if (event.type === "projection.result_recorded") {
      const typedDecision = validateProjectionResultRecordedEvent(event, { expectedRunId: runId, expectedSequence, snapshot: replay, durableContract: true });
      if (!typedDecision.ok) return { ok: false, reason: typedDecision.error };
      const semanticError = validateProjectionResultReplaySemantics(replay, event.evidence, idempotencyPayloads);
      if (semanticError) return { ok: false, reason: semanticError };
      idempotencyPayloads.set(event.evidence.idempotency_key, canonicalJson(event.evidence));
      Object.assign(replay, mergeProjectionSnapshot(replay, { ...event.evidence, type: event.type }, event.sequence));
      continue;
    }

    replay.last_sequence = event.sequence;
  }

  return { ok: true, replay };
}

async function quarantineRun(registryRoot, runDir, runId, reason, details, { clock, registryRepository, registryRecoveryStore }) {
  const registry = assertRegistryRepository(registryRepository);
  const store = assertRegistryRecoveryStore(registryRecoveryStore);
  return store.quarantineRun({ paths: registry.getRegistryPaths(registryRoot), runDir, runId, reason, details, clock, registryRepository: registry });
}

async function inspectRun(registryRoot, entry, { clock, registryRepository, registryRecoveryStore }) {
  const registry = assertRegistryRepository(registryRepository);
  const store = assertRegistryRecoveryStore(registryRecoveryStore);
  const runId = typeof entry === "string" ? entry : entry.name;
  const runDir = path.join(registry.getRegistryPaths(registryRoot).runs, runId);
  const runPath = path.join(runDir, "run.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  let snapshot;
  try {
    snapshot = await store.readRunJson({ runDir, runPath, runId });
  } catch (error) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "corrupt_run_json", { error: error?.message || String(error) }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  const snapshotDecision = validateRunSnapshot(snapshot, { expectedRunId: runId, mode: "recovery" });
  if (!snapshotDecision.ok) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "invalid_run_snapshot", { error: snapshotDecision.error }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  let eventsResult;
  try {
    eventsResult = await readEventsStrict(store, eventsPath);
  } catch (error) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "missing_or_unreadable_events", { error: error?.message || String(error) }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  if (eventsResult.malformed.length > 0) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "malformed_events_jsonl", { malformed: eventsResult.malformed }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  const replay = replayDomainEvents(eventsResult.events, runId, snapshot);
  if (!replay.ok) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "invalid_event_replay", { error: replay.reason }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  if (!compareSemanticSlice(snapshot, replay.replay)) {
    const reason = snapshot.state !== replay.replay.state ? "snapshot_event_state_mismatch" : "snapshot_semantic_mismatch";
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, reason, {
        snapshot: {
          state: snapshot.state,
          last_sequence: snapshot.last_sequence,
          execution: snapshot.execution,
          gates: snapshot.gates,
          artifacts: snapshot.artifacts?.recorded || { by_path: {} },
        },
        replay: {
          state: replay.replay.state,
          last_sequence: replay.replay.last_sequence,
          execution: replay.replay.execution,
          gates: replay.replay.gates,
          artifacts: replay.replay.artifacts.recorded,
        },
      }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  const artifactFindings = await verifyArtifactRefs(store, runDir, snapshot, eventsResult.events);
  const integrityErrors = artifactFindings.filter((finding) => finding.severity === "error");
  if (integrityErrors.length > 0) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "artifact_integrity_failure", { findings: integrityErrors }, { clock, registryRepository: registry, registryRecoveryStore: store }),
    };
  }

  return {
    status: "valid",
    snapshot,
    run: {
      run_id: runId,
      state: snapshot.state,
      terminal: TERMINAL_STATES.has(snapshot.state),
      events: eventsResult.events.length,
      artifact_findings: artifactFindings,
    },
  };
}

/**
 * Recovers registry state by validating runs, quarantining corrupt ones, and rebuilding indexes.
 *
 * @param {string} registryRoot
 * @param {{ clock?: () => Date }} [options]
 * @returns {Promise<Record<string, unknown>>}
 * @throws {Error}
 */
export async function recoverRegistry(registryRoot, { clock = () => new Date(), registryRepository, workspaceLeaseService, registryRecoveryStore } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for recovery");
  const registry = assertRegistryRepository(registryRepository);
  const leases = assertWorkspaceLeaseService(workspaceLeaseService);
  const store = assertRegistryRecoveryStore(registryRecoveryStore);
  const paths = registry.getRegistryPaths(registryRoot);
  await store.ensureRunsDir({ paths, registryRoot });
  const entries = await store.listRunDirs({ paths, registryRoot });

  const validSnapshots = [];
  const runs = [];
  const quarantined = [];
  const findings = [];

  for (const entry of entries.sort((a, b) => String(a).localeCompare(String(b)))) {
    const inspected = await inspectRun(registryRoot, entry, { clock, registryRepository: registry, registryRecoveryStore: store });
    if (inspected.status === "quarantined") {
      quarantined.push(inspected.quarantine);
      findings.push({ severity: "error", type: "quarantined_run", run_id: inspected.quarantine.run_id, reason: inspected.quarantine.reason });
      continue;
    }
    validSnapshots.push(inspected.snapshot);
    runs.push(inspected.run);
    findings.push(...inspected.run.artifact_findings.map((finding) => ({ run_id: inspected.run.run_id, ...finding })));
  }

  const leaseRecovery = await leases.recover(registryRoot, validSnapshots, { clock });
  findings.push(...leaseRecovery.findings);

  const indexes = await registry.rebuildIndexes(registryRoot, { clock, snapshots: leaseRecovery.snapshots });
  const report = {
    schema_version: SCHEMA_VERSION,
    mode: "recovery",
    registry_root: registryRoot,
    recovered_at: clock().toISOString(),
    summary: {
      inspected_runs: runs.length + quarantined.length,
      valid_runs: runs.length,
      quarantined_runs: quarantined.length,
      findings: findings.length,
      active_runs: indexes.active_runs.length,
      workspace_leases: indexes.workspace_leases.length,
    },
    runs,
    quarantined,
    findings,
    indexes,
    lease_recovery: {
      active_lease_records: leaseRecovery.active_lease_record_paths.length,
      active_lease_record_paths: leaseRecovery.active_lease_record_paths,
    },
    external_side_effects: false,
  };
  await store.writeRecoveryReport({ paths, report, registryRepository: registry });
  return report;
}

export { formatRecoveryReport } from "./reporting.js";
