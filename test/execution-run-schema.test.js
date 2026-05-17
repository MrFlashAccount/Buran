import test from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_VERSION } from "../src/constants.js";
import {
  buildInitialRunSnapshot,
  buildLeaseRecord,
  findArtifactRefs,
  validateArtifactRecordedPayload,
  validateGateResultPayload,
  validateLeaseRecord,
  validateRunSnapshot,
} from "../src/execution-run-schema.js";

function sampleReport() {
  return {
    run_id: "run_schema_good",
    task_id: "schema-good",
    github: { repo: "MrFlashAccount/example-repo", issue_number: 17, intended_branch: "sergey/schema-good" },
    packet_hash: "abc123",
    source_path: "/tmp/packets.json",
    approval: { approved: true },
    sufficiency_status: "PASS",
    missing_fields: [],
    conflict_surface: ["src/schema"],
  };
}

function initialSnapshot(overrides = {}) {
  return {
    ...buildInitialRunSnapshot(sampleReport(), {
      createdAt: "2026-05-16T13:52:00.000Z",
      packetArtifactRef: { path: "artifacts/packet.md", sha256: "a".repeat(64) },
    }),
    ...overrides,
  };
}

test("execution-run schema builds the current initial snapshot shape", () => {
  const snapshot = initialSnapshot();

  assert.equal(snapshot.schema_version, SCHEMA_VERSION);
  assert.equal(snapshot.state, "packet_received");
  assert.equal(snapshot.last_sequence, 1);
  assert.equal(snapshot.execution.current_epoch, 0);
  assert.deepEqual(snapshot.gates.verification, {
    status: "PENDING",
    current_epoch: 0,
    current_attempt: 0,
    recorded_from_state: "",
    artifact_refs: [],
    recorded_at: null,
    actor: "",
    idempotency_key: "",
  });
  assert.deepEqual(snapshot.gates.internal_review, snapshot.gates.verification);
  assert.deepEqual(snapshot.artifacts.recorded, { by_path: {} });
  assert.equal(snapshot.workspace.lease_status, "not_requested");
  assert.equal(snapshot.locks.lease_status, "not_requested");
  assert.equal(validateRunSnapshot(snapshot, { expectedRunId: snapshot.run_id }).ok, true);
});

test("execution-run schema accepts queued, running with lease, and terminal blocked snapshots", () => {
  const queued = initialSnapshot({ state: "queued", updated_at: "2026-05-16T13:53:00.000Z", last_sequence: 2 });
  assert.equal(validateRunSnapshot(queued, { expectedRunId: queued.run_id }).ok, true);

  const running = initialSnapshot({
    state: "running",
    workspace: { id: "ws-a", path: "/tmp/ws-a", lease_status: "acquired", lease_id: "lease_a", acquired_at: "2026-05-16T13:54:00.000Z", expires_at: "2026-05-16T14:54:00.000Z", ttl_ms: 3_600_000 },
    locks: { repo: "MrFlashAccount/example-repo", issue: 17, branch: "sergey/schema-good", conflict_surface: ["src/schema"], lease_status: "acquired", lease_id: "lease_a", lock_keys: [], acquired_at: "2026-05-16T13:54:00.000Z", expires_at: "2026-05-16T14:54:00.000Z", ttl_ms: 3_600_000 },
    updated_at: "2026-05-16T13:54:00.000Z",
    last_sequence: 4,
  });
  assert.equal(validateRunSnapshot(running, { expectedRunId: running.run_id }).ok, true);

  const blocked = initialSnapshot({ state: "blocked_plan_insufficient", terminal_reason: "Packet insufficient: missing implementation", updated_at: "2026-05-16T13:55:00.000Z", last_sequence: 2 });
  assert.equal(validateRunSnapshot(blocked, { expectedRunId: blocked.run_id }).ok, true);
});

test("execution-run schema rejects terminal blocked snapshots without terminal_reason", () => {
  const decision = validateRunSnapshot(initialSnapshot({ state: "failed_execution", terminal_reason: "" }), { expectedRunId: "run_schema_good" });
  assert.equal(decision.ok, false);
  assert.match(decision.error, /terminal_reason must be non-empty/);
});

test("execution-run schema rejects invalid gate status, wrong run id, and unsupported schema version", () => {
  const invalidGate = initialSnapshot({
    gates: {
      verification: { ...initialSnapshot().gates.verification, status: "MAYBE" },
      internal_review: initialSnapshot().gates.internal_review,
    },
  });
  assert.match(validateRunSnapshot(invalidGate, { expectedRunId: invalidGate.run_id }).error, /unsupported value: MAYBE/);

  assert.match(validateRunSnapshot(initialSnapshot(), { expectedRunId: "different_run" }).error, /does not match folder different_run/);
  assert.match(validateRunSnapshot(initialSnapshot({ schema_version: "execution-run.v1" }), { expectedRunId: "run_schema_good" }).error, /unsupported run\.json schema_version/);
});

test("execution-run schema validates artifact and gate-result payload contracts", () => {
  const artifactPayload = {
    path: "artifacts/verification/report.json",
    sha256: "b".repeat(64),
    bytes: 42,
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    recorded_at: "2026-05-16T14:00:00.000Z",
    actor: "schema-test",
    provenance: { kind: "verification-json" },
  };
  assert.equal(validateArtifactRecordedPayload(artifactPayload).ok, true);
  assert.match(validateArtifactRecordedPayload({ ...artifactPayload, path: "../escape.txt" }).error, /safe relative path/);

  const gatePayload = {
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    status: "PASS",
    artifact_refs: [{ path: artifactPayload.path, sha256: artifactPayload.sha256 }],
    recorded_at: "2026-05-16T14:01:00.000Z",
    actor: "schema-test",
    idempotency_key: "gate-pass-1",
  };
  assert.equal(validateGateResultPayload(gatePayload).ok, true);
  assert.match(validateGateResultPayload({ ...gatePayload, status: "MAYBE" }).error, /unsupported value/);
});

test("execution-run schema reports malformed artifact refs and traverses path escapes for recovery", () => {
  const malformed = initialSnapshot({ artifacts: { packet: { path: "artifacts/packet.md" }, recorded: { by_path: {} } } });
  assert.match(validateRunSnapshot(malformed, { expectedRunId: malformed.run_id }).error, /artifacts\.packet\.sha256/);

  const refs = findArtifactRefs({ nested: [{ path: "../outside", sha256: "b".repeat(64) }] });
  assert.deepEqual(refs, [{ path: "../outside", sha256: "b".repeat(64) }]);
});

test("execution-run schema owns lease record construction and validation", () => {
  const request = {
    lease_id: "lease_schema",
    run_id: "run_schema_good",
    task_id: "schema-good",
    workspace_id: "ws-schema",
    workspace_path: "/tmp/ws-schema",
    repo: "MrFlashAccount/example-repo",
    issue_number: 17,
    branch: "sergey/schema-good",
    conflict_surface: ["src/schema"],
    acquired_at: "2026-05-16T13:54:00.000Z",
    expires_at: "2026-05-16T14:54:00.000Z",
    ttl_ms: 3_600_000,
  };
  const record = buildLeaseRecord(request, { surface: "issue", key: "issue:repo#17", value: "repo#17" });
  assert.equal(record.schema_version, SCHEMA_VERSION);
  assert.equal(record.status, "acquired");
  assert.equal(validateLeaseRecord(record).ok, true);
  assert.match(validateLeaseRecord({ ...record, status: "mystery" }).error, /unsupported value/);
});
