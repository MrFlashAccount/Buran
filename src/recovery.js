import { promises as fs } from "node:fs";
import path from "node:path";

import { ARTIFACT_STAGE_STATE_BY_NAME, GATE_NAMES, GATE_STATE_BY_NAME, GATE_STATUS, SCHEMA_VERSION, TERMINAL_STATES } from "./constants.js";
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
} from "./execution-run-schema.js";
import { mergeProjectionSnapshot } from "./projection-contract.js";
import { recoverLeaseRecords } from "./locks.js";
import { getRegistryPaths, rebuildIndexes, writeRegistryReport } from "./registry-store.js";
import { applyTransitionToSnapshot, validateTransition, validateTransitionEvent } from "./state-machine.js";
import { canonicalJson, sha256Hex } from "./utils.js";

function safeReasonPart(reason) {
  return String(reason || "invalid")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "invalid";
}

async function readJsonStrict(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

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

async function readEventsStrict(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return parseJsonLinesStrict(raw);
}

async function verifyArtifactRefs(runDir, snapshot, events) {
  const refs = findArtifactRefs(snapshot).concat(findArtifactRefs(events));
  const unique = new Map();
  for (const ref of refs) unique.set(`${ref.path}:${ref.sha256}`, ref);
  const findings = [];
  for (const ref of unique.values()) {
    const artifactPath = path.resolve(runDir, ref.path);
    const relativeCheck = path.relative(runDir, artifactPath);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
      findings.push({ severity: "error", type: "artifact_path_escape", path: ref.path });
      continue;
    }
    try {
      const content = await fs.readFile(artifactPath);
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
    github: {
      repo: snapshot.github?.repo || "",
      issue_number: snapshot.github?.issue_number ?? null,
      intended_branch: snapshot.github?.intended_branch || "",
      base_branch: snapshot.github?.base_branch || "",
      pr: null,
    },
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
    projections: {},
  };
}

function compareSemanticSlice(snapshot, replay) {
  return canonicalJson({
    state: snapshot.state,
    last_sequence: snapshot.last_sequence,
    execution: snapshot.execution,
    gates: snapshot.gates,
    artifacts: snapshot.artifacts?.recorded || { by_path: {} },
    github: {
      pr: snapshot.github?.pr ?? null,
    },
    projections: snapshot.projections || {},
  }) === canonicalJson({
    state: replay.state,
    last_sequence: replay.last_sequence,
    execution: replay.execution,
    gates: replay.gates,
    artifacts: replay.artifacts.recorded,
    github: {
      pr: replay.github?.pr ?? null,
    },
    projections: replay.projections,
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

function projectionHead(snapshot) {
  return snapshot.projections?.github_pr || null;
}

function validateProjectionIntentReplaySemantics(snapshot, payload, idempotencyPayloads) {
  if (snapshot.state !== "pr_ready") return `projection.intent_recorded requires current state pr_ready; got ${snapshot.state}`;
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
  if (snapshot.state !== "pr_ready") return `projection.result_recorded requires current state pr_ready; got ${snapshot.state}`;
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

  const payloadDecision = validateProjectionResultPayload(payload, { fieldPath: "event.evidence", snapshot });
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
      const typedDecision = validateProjectionResultRecordedEvent(event, { expectedRunId: runId, expectedSequence, snapshot: replay });
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

async function quarantineRun(registryRoot, runDir, runId, reason, details, { clock }) {
  const paths = getRegistryPaths(registryRoot);
  const timestamp = clock().toISOString().replace(/\D/g, "").slice(0, 14) || "undated";
  const targetDir = path.join(paths.quarantine, `${timestamp}_${runId}_${safeReasonPart(reason)}`);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.rename(runDir, targetDir);
  const reportPath = path.join(targetDir, "quarantine-report.json");
  const report = {
    schema_version: SCHEMA_VERSION,
    quarantined_at: clock().toISOString(),
    run_id: runId,
    reason,
    details,
    original_run_dir: runDir,
    quarantine_dir: targetDir,
    human_needed: true,
  };
  await writeRegistryReport(reportPath, report);
  return { run_id: runId, reason, quarantine_dir: targetDir, report_path: reportPath };
}

async function inspectRun(registryRoot, entry, { clock }) {
  const runId = entry.name;
  const runDir = path.join(getRegistryPaths(registryRoot).runs, runId);
  const runPath = path.join(runDir, "run.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  let snapshot;
  try {
    snapshot = await readJsonStrict(runPath);
  } catch (error) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "corrupt_run_json", { error: error?.message || String(error) }, { clock }),
    };
  }

  const snapshotDecision = validateRunSnapshot(snapshot, { expectedRunId: runId, mode: "recovery" });
  if (!snapshotDecision.ok) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "invalid_run_snapshot", { error: snapshotDecision.error }, { clock }),
    };
  }

  let eventsResult;
  try {
    eventsResult = await readEventsStrict(eventsPath);
  } catch (error) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "missing_or_unreadable_events", { error: error?.message || String(error) }, { clock }),
    };
  }

  if (eventsResult.malformed.length > 0) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "malformed_events_jsonl", { malformed: eventsResult.malformed }, { clock }),
    };
  }

  const replay = replayDomainEvents(eventsResult.events, runId, snapshot);
  if (!replay.ok) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "invalid_event_replay", { error: replay.reason }, { clock }),
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
      }, { clock }),
    };
  }

  const artifactFindings = await verifyArtifactRefs(runDir, snapshot, eventsResult.events);
  const integrityErrors = artifactFindings.filter((finding) => finding.severity === "error");
  if (integrityErrors.length > 0) {
    return {
      status: "quarantined",
      quarantine: await quarantineRun(registryRoot, runDir, runId, "artifact_integrity_failure", { findings: integrityErrors }, { clock }),
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

export async function recoverRegistry(registryRoot, { clock = () => new Date() } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for recovery");
  const paths = getRegistryPaths(registryRoot);
  await fs.mkdir(paths.runs, { recursive: true });
  const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  const validSnapshots = [];
  const runs = [];
  const quarantined = [];
  const findings = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const inspected = await inspectRun(registryRoot, entry, { clock });
    if (inspected.status === "quarantined") {
      quarantined.push(inspected.quarantine);
      findings.push({ severity: "error", type: "quarantined_run", run_id: inspected.quarantine.run_id, reason: inspected.quarantine.reason });
      continue;
    }
    validSnapshots.push(inspected.snapshot);
    runs.push(inspected.run);
    findings.push(...inspected.run.artifact_findings.map((finding) => ({ run_id: inspected.run.run_id, ...finding })));
  }

  const leaseRecovery = await recoverLeaseRecords(registryRoot, validSnapshots, { clock });
  findings.push(...leaseRecovery.findings);

  const indexes = await rebuildIndexes(registryRoot, { clock, snapshots: leaseRecovery.snapshots });
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
  await writeRegistryReport(path.join(paths.indexes, "recovery-report.json"), report);
  return report;
}

export function formatRecoveryReport(report) {
  const lines = [];
  lines.push("buran: recovery");
  lines.push(`Registry: ${report.registry_root}`);
  lines.push(`Runs: inspected=${report.summary.inspected_runs}; valid=${report.summary.valid_runs}; quarantined=${report.summary.quarantined_runs}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push(`Active index: ${report.summary.active_runs}; workspace leases=${report.summary.workspace_leases}`);
  lines.push("External side effects: no");
  for (const quarantine of report.quarantined) {
    lines.push(`- quarantined ${quarantine.run_id}: ${quarantine.reason} -> ${quarantine.quarantine_dir}`);
  }
  for (const finding of report.findings.filter((entry) => entry.type !== "quarantined_run")) {
    lines.push(`- finding ${finding.run_id || "registry"}: ${finding.type}`);
  }
  return lines.join("\n");
}
