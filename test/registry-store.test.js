import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SCHEMA_VERSION } from "../src/core/modules/execution-runs/constants.js";
import { buildRunnerReport } from "../src/application/final-report.js";
import { deriveWorkerTaskSummary, markWorkerTaskOverdue } from "../src/core/modules/execution-runs/entities/worker-task.js";
import { recoverRegistry as recoverRegistryCore } from "../src/execution-runs/recovery/index.js";
import { createJsonRegistryRepository } from "../src/integrations/storage/json-registry/repository.js";
import { createJsonLeaseRecordStore } from "../src/integrations/storage/json-registry/lease-record-store.js";
import { createJsonRegistryRecoveryStore } from "../src/integrations/storage/json-registry/recovery-store.js";
import { createFilesystemWorkspaceLeaseService } from "../src/integrations/worktree/filesystem/locks.js";
import { createRunFromPacketReport, getRunPaths, readEventsFile, readRunSnapshot, rebuildIndexes, transitionRun, recordWorkerTaskCreated, recordWorkerTaskDispatch, recordWorkerCompletion, recordWorkerCompletionDecision, recordWorkerTaskOverdue, quarantineWorkerTask } from "../src/integrations/storage/json-registry/store.js";

/**
 * Persistence and recovery tests for the registry store. Helpers keep packet and
 * JSON fixture construction consistent while the assertions focus on state changes.
 */

const registryRepository = createJsonRegistryRepository();
const leaseRecordStore = createJsonLeaseRecordStore();
const workspaceLeaseService = createFilesystemWorkspaceLeaseService({ registryRepository, leaseRecordStore });
const registryRecoveryStore = createJsonRegistryRecoveryStore();
const recoverRegistry = (registryRoot, options = {}) => recoverRegistryCore(registryRoot, { ...options, registryRepository: options.registryRepository || registryRepository, workspaceLeaseService: options.workspaceLeaseService || workspaceLeaseService, registryRecoveryStore: options.registryRecoveryStore || registryRecoveryStore });

/** Creates an isolated registry root for store-level tests. */
async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "buran-store-test-"));
}

/** Reads JSON fixtures written by registry index helpers during the test. */
async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

/** Builds the standard sufficient packet report used by registry store tests. */
function packetReport(runId = "run_store_good") {
  return {
    run_id: runId,
    task_id: "store-good",
    source_path: "/tmp/store-packets.json",
    packet_hash: "hash-store-good",
    raw: { task_id: "store-good", approved: true },
    github: { repo: "example-owner/example-repo", issue_number: 88, intended_branch: "user/store-good", base_branch: "develop" },
    approval: { approved: true },
    sufficiency_status: "PASS",
    missing_fields: [],
    conflict_surface: ["src/store"],
    sufficient: true,
  };
}

test("registry store creates a run with packet artifact, event journal, snapshot, and indexes", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");

  const result = await createRunFromPacketReport(packetReport(), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, result.run.run_id);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));

  assert.equal(snapshot.state, "queued");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.state_after), ["packet_received", "queued"]);
  assert.equal(await fs.readFile(path.join(paths.runDir, snapshot.artifacts.packet.path), "utf8").then((text) => text.includes("Approved packet snapshot")), true);
  assert.deepEqual(activeRuns.runs.map((run) => run.run_id), [result.run.run_id]);
});

test("registry store transition appends one event and writes a matching snapshot state", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport(), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });

  const transitioned = await transitionRun(registryRoot, created.run.run_id, {
    toState: "waiting_for_lock",
    actor: "store-test",
    evidence: { reason: "accepted into manual batch" },
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, created.run.run_id);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(transitioned.event.sequence, 3);
  assert.equal(snapshot.state, "waiting_for_lock");
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).state_after, snapshot.state);
});

test("registry store rebuilds missing indexes from valid run snapshots", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport(), { registryRoot });
  await fs.rm(path.join(registryRoot, "indexes"), { recursive: true, force: true });

  const indexes = await rebuildIndexes(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.deepEqual(indexes.active_runs.map((run) => run.run_id), [created.run.run_id]);
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.equal(activeRuns.updated_at, "2026-05-16T14:00:00.000Z");
});

test("registry recovery deterministically quarantines event-before-snapshot stale state", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport(), { registryRoot });
  const paths = getRunPaths(registryRoot, created.run.run_id);
  await fs.appendFile(paths.eventsPath, `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    run_id: created.run.run_id,
    sequence: 3,
    timestamp: "2026-05-16T13:53:00.000Z",
    type: "transition",
    state_before: "queued",
    state_after: "waiting_for_lock",
    actor: "store-test",
    evidence: { reason: "event committed before snapshot" },
    idempotency_key: `${created.run.run_id}:waiting_for_lock:3`,
  })}\n`, "utf8");

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:54:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "snapshot_event_state_mismatch");
});

test("registry recovery quarantines artifact-written but event-missing stale state", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport(), { registryRoot });
  const paths = getRunPaths(registryRoot, created.run.run_id);
  const events = await readEventsFile(paths.eventsPath);
  await fs.writeFile(paths.eventsPath, `${JSON.stringify(events[0])}\n`, "utf8");

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:54:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "snapshot_event_state_mismatch");
});

async function createDispatchedWorkerTask(registryRoot, runId, { purpose = "implementation_dispatch", attempt = 1, recordedAt = "2026-05-16T13:53:00.000Z", idSuffix = purpose } = {}) {
  const created = await recordWorkerTaskCreated(registryRoot, runId, {
    purpose,
    attempt,
    recorded_at: recordedAt,
    idempotency_key: `${runId}:worker_task:${idSuffix}:created`,
  });
  const dispatched = await recordWorkerTaskDispatch(registryRoot, runId, {
    recorded_at: new Date(Date.parse(recordedAt) + 1000).toISOString(),
    idempotency_key: `${runId}:worker_task:${idSuffix}:dispatch`,
  });
  return dispatched.run.worker_tasks.head;
}

test("late completion observation does not overwrite current active worker task", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_late_active"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const firstHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "implementation_dispatch", idSuffix: "impl" });
  const secondHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "fix_attempt", attempt: 1, recordedAt: "2026-05-16T13:54:00.000Z", idSuffix: "fix" });

  const late = await recordWorkerCompletion(registryRoot, created.run.run_id, {
    worker_task_id: firstHead.worker_task_id,
    purpose: firstHead.purpose,
    epoch: firstHead.epoch,
    attempt: firstHead.attempt,
    authority: firstHead.authority,
    status: "COMPLETED",
    received_at: "2026-05-16T13:56:00.000Z",
    idempotency_key: `${firstHead.worker_task_id}:late-completion`,
  });

  assert.equal(late.run.worker_tasks.head.worker_task_id, secondHead.worker_task_id);
  assert.equal(late.run.worker_tasks.head.status, "dispatched");
  assert.equal(late.event.evidence.role, "implementer");
  assert.equal(secondHead.role, "fixer");
  assert.ok(late.run.worker_tasks.history.some((entry) => entry.worker_task_id === firstHead.worker_task_id && entry.status === "late" && entry.role === "implementer"));
  assert.equal(late.run.worker_tasks.history.some((entry) => entry.worker_task_id === secondHead.worker_task_id && entry.status === "late"), false);

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:57:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 0);
  const recoveredSnapshot = await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath);
  assert.equal(recoveredSnapshot.worker_tasks.head.worker_task_id, secondHead.worker_task_id);
  assert.equal(recoveredSnapshot.worker_tasks.head.status, "dispatched");
  assert.ok(recoveredSnapshot.worker_tasks.history.some((entry) => entry.worker_task_id === firstHead.worker_task_id && entry.status === "late" && entry.role === "implementer"));
  assert.equal(recoveredSnapshot.worker_tasks.history.some((entry) => entry.worker_task_id === secondHead.worker_task_id && entry.status === "late"), false);
});

test("late completion decision replay does not overwrite current active worker task", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_late_decision_active"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const firstHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "implementation_dispatch", idSuffix: "impl" });
  const secondHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "fix_attempt", attempt: 1, recordedAt: "2026-05-16T13:54:00.000Z", idSuffix: "fix" });
  const staleCompletion = {
    worker_task_id: firstHead.worker_task_id,
    purpose: firstHead.purpose,
    role: firstHead.role,
    epoch: firstHead.epoch,
    attempt: firstHead.attempt,
    authority: firstHead.authority,
    status: "COMPLETED",
    evidence: { files_changed: [{ path: "src/stale-worker.js", sha256: "abc123" }] },
    received_at: "2026-05-16T13:56:00.000Z",
    idempotency_key: `${firstHead.worker_task_id}:late-decision-completion`,
  };

  const observed = await recordWorkerCompletion(registryRoot, created.run.run_id, staleCompletion);
  const decided = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, {
    completion: staleCompletion,
    decided_at: "2026-05-16T13:56:01.000Z",
    idempotency_key: `${firstHead.worker_task_id}:late-decision`,
  });

  assert.equal(decided.event.type, "worker_task.completion_decided");
  assert.equal(decided.event.evidence.worker_task_id, firstHead.worker_task_id);
  assert.equal(decided.event.evidence.decision, "late");
  assert.equal(decided.event.evidence.role, "implementer");
  assert.deepEqual(decided.run.worker_tasks.head, observed.run.worker_tasks.head);
  assert.equal(decided.run.worker_tasks.head.worker_task_id, secondHead.worker_task_id);
  assert.equal(decided.run.worker_tasks.head.status, "dispatched");
  assert.equal(decided.run.worker_tasks.head.role, "fixer");
  assert.ok(decided.run.worker_tasks.history.some((entry) => entry.worker_task_id === firstHead.worker_task_id && entry.status === "late" && entry.completion?.idempotency_key === staleCompletion.idempotency_key));
  assert.equal(decided.run.worker_tasks.history.some((entry) => entry.worker_task_id === secondHead.worker_task_id && entry.status === "late"), false);

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:57:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 0);
  const recoveredSnapshot = await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath);
  assert.equal(recoveredSnapshot.worker_tasks.head.worker_task_id, secondHead.worker_task_id);
  assert.equal(recoveredSnapshot.worker_tasks.head.status, "dispatched");
  assert.equal(recoveredSnapshot.worker_tasks.head.role, "fixer");
  assert.ok(recoveredSnapshot.worker_tasks.history.some((entry) => entry.worker_task_id === firstHead.worker_task_id && entry.status === "late" && entry.completion?.idempotency_key === staleCompletion.idempotency_key));
  assert.equal(recoveredSnapshot.worker_tasks.history.some((entry) => entry.worker_task_id === secondHead.worker_task_id && entry.status === "late"), false);
});

test("conflict and unauthorized completions do not overwrite accepted worker task truth", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_conflict_accepted"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const acceptedCompletion = {
    worker_task_id: head.worker_task_id,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:accepted`,
  };
  await recordWorkerCompletion(registryRoot, created.run.run_id, acceptedCompletion);
  const accepted = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, {
    completion: acceptedCompletion,
    decided_at: "2026-05-16T13:54:01.000Z",
    idempotency_key: `${head.worker_task_id}:accepted:decision`,
  });
  assert.equal(accepted.event.type, "worker_task.completion_decided");
  assert.equal(accepted.event.evidence.decision, "accepted");
  assert.equal(accepted.event.evidence.completion_status, "COMPLETED");
  assert.equal(accepted.event.evidence.role, "implementer");
  assert.equal(accepted.run.worker_tasks.head.status, "completed");
  assert.equal(accepted.run.worker_tasks.head.role, "implementer");
  assert.equal(accepted.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);

  const conflictCompletion = { ...acceptedCompletion, idempotency_key: `${head.worker_task_id}:conflict`, received_at: "2026-05-16T13:55:00.000Z" };
  const conflictObserved = await recordWorkerCompletion(registryRoot, created.run.run_id, conflictCompletion);
  const conflictDecided = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, {
    completion: conflictCompletion,
    decided_at: "2026-05-16T13:55:01.000Z",
    idempotency_key: `${head.worker_task_id}:conflict:decision`,
  });
  assert.equal(conflictObserved.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);
  assert.equal(conflictDecided.event.type, "worker_task.completion_decided");
  assert.equal(conflictDecided.event.evidence.decision, "conflict");
  assert.equal(conflictDecided.event.evidence.completion_status, "COMPLETED");
  assert.equal(conflictDecided.run.worker_tasks.head.status, "completed");
  assert.equal(conflictDecided.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);

  const unauthorizedCompletion = { ...acceptedCompletion, authority: "wrong-authority", idempotency_key: `${head.worker_task_id}:unauthorized`, received_at: "2026-05-16T13:56:00.000Z" };
  const unauthorizedObserved = await recordWorkerCompletion(registryRoot, created.run.run_id, unauthorizedCompletion);
  assert.equal(unauthorizedObserved.run.worker_tasks.head.status, "completed");
  assert.equal(unauthorizedObserved.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);

  const unknownCompletion = { ...acceptedCompletion, task_id: "different-task", idempotency_key: `${head.worker_task_id}:unknown`, received_at: "2026-05-16T13:57:00.000Z" };
  const unknownObserved = await recordWorkerCompletion(registryRoot, created.run.run_id, unknownCompletion);
  const unknownDecided = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: unknownCompletion, decided_at: "2026-05-16T13:57:01.000Z", idempotency_key: `${head.worker_task_id}:unknown:decision` });
  assert.equal(unknownDecided.event.evidence.decision, "unknown");
  assert.equal(unknownObserved.run.worker_tasks.head.status, "completed");
  assert.equal(unknownDecided.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);
});

test("duplicate after accepted requires durable completion identity instead of null completion refs", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_duplicate_identity"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const acceptedCompletion = {
    worker_task_id: head.worker_task_id,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:accepted-null-ref`,
  };
  await recordWorkerCompletion(registryRoot, created.run.run_id, acceptedCompletion);
  await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: acceptedCompletion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:accepted-null-ref:decision` });

  const arbitraryRepeat = { ...acceptedCompletion, idempotency_key: `${head.worker_task_id}:different-null-ref`, received_at: "2026-05-16T13:55:00.000Z" };
  await recordWorkerCompletion(registryRoot, created.run.run_id, arbitraryRepeat);
  const arbitraryDecision = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: arbitraryRepeat, decided_at: "2026-05-16T13:55:01.000Z", idempotency_key: `${head.worker_task_id}:different-null-ref:decision` });
  assert.equal(arbitraryDecision.event.evidence.decision, "conflict");
  assert.equal(arbitraryDecision.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);

  const durableRepeat = { ...acceptedCompletion, received_at: "2026-05-16T13:56:00.000Z" };
  await recordWorkerCompletion(registryRoot, created.run.run_id, durableRepeat);
  const durableDecision = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: durableRepeat, decided_at: "2026-05-16T13:56:01.000Z", idempotency_key: `${head.worker_task_id}:same-id:decision` });
  assert.equal(durableDecision.event.evidence.decision, "duplicate");
  assert.equal(durableDecision.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);
});

test("recovery replays multiple worker tasks in one execution run", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_multi_recovery"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const firstHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "implementation_dispatch", idSuffix: "impl" });
  const firstCompletion = { worker_task_id: firstHead.worker_task_id, purpose: firstHead.purpose, epoch: firstHead.epoch, attempt: firstHead.attempt, authority: firstHead.authority, status: "FAILED", received_at: "2026-05-16T13:54:00.000Z", idempotency_key: `${firstHead.worker_task_id}:failed` };
  await recordWorkerCompletion(registryRoot, created.run.run_id, firstCompletion);
  await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: firstCompletion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${firstHead.worker_task_id}:failed:decision` });
  const secondHead = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { purpose: "fix_attempt", attempt: 1, recordedAt: "2026-05-16T13:55:00.000Z", idSuffix: "fix" });

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:56:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 0);
  assert.ok(recovery.runs.some((run) => run.run_id === created.run.run_id));
  const recoveredSnapshot = await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath);
  assert.equal(recoveredSnapshot.worker_tasks.head.worker_task_id, secondHead.worker_task_id);
  assert.equal(recoveredSnapshot.worker_tasks.head.status, "dispatched");
  assert.ok(recoveredSnapshot.worker_tasks.history.some((entry) => entry.worker_task_id === firstHead.worker_task_id && entry.status === "failed"));
});

test("worker task summary redacts absolute paths and secrets from completion evidence", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_privacy_summary"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const completion = {
    worker_task_id: head.worker_task_id,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    evidence: {
      files_changed: ["src/safe.js", "/Users/sergey/private/raw-prompt.txt"],
      status: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      raw_output: "raw transcript should never appear",
    },
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:privacy`,
  };
  await recordWorkerCompletion(registryRoot, created.run.run_id, completion);
  const decided = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:privacy:decision` });

  const summary = deriveWorkerTaskSummary(decided.run.worker_tasks.head);
  const text = JSON.stringify(summary);
  assert.equal(text.includes("/Users/sergey/private"), false);
  assert.equal(text.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(text.includes("raw transcript"), false);
  assert.deepEqual(summary.evidence.files_changed, ["src/safe.js"]);
});

test("forced accepted completion decision cannot override evaluator truth", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_forced_accepted_guard"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const acceptedCompletion = {
    worker_task_id: head.worker_task_id,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:accepted`,
  };
  await recordWorkerCompletion(registryRoot, created.run.run_id, acceptedCompletion);
  const accepted = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion: acceptedCompletion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:accepted:decision` });
  assert.equal(accepted.run.worker_tasks.head.status, "completed");

  const conflictingCompletion = { ...acceptedCompletion, status: "FAILED", idempotency_key: `${head.worker_task_id}:forced-conflict`, received_at: "2026-05-16T13:55:00.000Z" };
  const forced = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, {
    completion: conflictingCompletion,
    decision: "accepted",
    reason: "operator must not be able to override accepted truth",
    decided_at: "2026-05-16T13:55:01.000Z",
    idempotency_key: `${head.worker_task_id}:forced-conflict:decision`,
  });

  assert.equal(forced.event.evidence.decision, "conflict");
  assert.equal(forced.run.worker_tasks.head.status, "completed");
  assert.equal(forced.run.worker_tasks.head.completion.idempotency_key, acceptedCompletion.idempotency_key);
});

test("forced accepted completion decision with mismatched worker_task_id records safe evidence", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_forced_mismatch_guard"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const mismatchedCompletion = {
    worker_task_id: `${head.worker_task_id}:stale`,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:forced-mismatch`,
  };

  const forced = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, {
    completion: mismatchedCompletion,
    decision: "accepted",
    reason: "operator must not be able to override mismatched worker task identity",
    decided_at: "2026-05-16T13:54:01.000Z",
    idempotency_key: `${head.worker_task_id}:forced-mismatch:decision`,
  });

  assert.equal(forced.event.evidence.decision, "late");
  assert.notEqual(forced.event.evidence.decision, "accepted");
  assert.equal(forced.run.worker_tasks.head.worker_task_id, head.worker_task_id);
  assert.equal(forced.run.worker_tasks.head.status, "dispatched");
  assert.equal(forced.run.worker_tasks.head.completion, null);
});

test("worker task summary drops non-Users Unix absolute paths through report surfaces", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_privacy_absolute_paths"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "impl" });
  const completion = {
    worker_task_id: head.worker_task_id,
    purpose: head.purpose,
    epoch: head.epoch,
    attempt: head.attempt,
    authority: head.authority,
    status: "COMPLETED",
    evidence: {
      files_changed: ["src/safe.js", "/tmp/leaked-worker-output.txt", "/home/ci/private.log"],
      artifact_ref: { path: "/tmp/result.json", sha256: "abc123", id: "safe-id" },
      branch: "feature/safe-relative-branch",
    },
    received_at: "2026-05-16T13:54:00.000Z",
    idempotency_key: `${head.worker_task_id}:privacy-absolute`,
  };
  await recordWorkerCompletion(registryRoot, created.run.run_id, completion);
  const decided = await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:privacy-absolute:decision` });

  const summary = deriveWorkerTaskSummary(decided.run.worker_tasks.head);
  const report = buildRunnerReport({
    registryRoot,
    runId: created.run.run_id,
    outcome: "completed",
    implementationDispatch: { status: "COMPLETED", worker_task: decided.run.worker_tasks.head },
  });
  const text = JSON.stringify({ summary, worker_task: report.worker_task });
  assert.equal(text.includes("/tmp/"), false);
  assert.equal(text.includes("/home/"), false);
  assert.deepEqual(summary.evidence.files_changed, ["src/safe.js"]);
  assert.equal(summary.evidence.artifact_ref.path, undefined);
  assert.equal(summary.evidence.artifact_ref.id, "safe-id");
  assert.deepEqual(report.worker_task.evidence.files_changed, ["src/safe.js"]);
});

test("worker task overdue marking mutates only active tasks and preserves terminal truth", async () => {
  const active = {
    run_id: "run_overdue_entity",
    task_id: "task",
    purpose: "implementation_dispatch",
    epoch: 1,
    attempt: 1,
    authority: "implementation-harness-dispatch.v1",
    status: "dispatched",
    created_at: "2026-05-16T13:52:00.000Z",
    updated_at: "2026-05-16T13:53:00.000Z",
  };
  assert.equal(markWorkerTaskOverdue(active, { recorded_at: "2026-05-16T13:54:00.000Z" }).status, "overdue");
  for (const status of ["completed", "failed", "quarantined"]) {
    const terminal = { ...active, status, updated_at: "2026-05-16T13:55:00.000Z" };
    const overdue = markWorkerTaskOverdue(terminal, { recorded_at: "2026-05-16T13:56:00.000Z" });
    assert.equal(overdue.status, status);
    assert.equal(overdue.updated_at, terminal.updated_at);
  }
});

test("recording overdue preserves completed failed and quarantined worker task truth", async () => {
  for (const status of ["completed", "failed", "quarantined"]) {
    const tempDir = await makeTempDir();
    const registryRoot = path.join(tempDir, "registry");
    const created = await createRunFromPacketReport(packetReport(`run_worker_overdue_${status}`), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
    const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: status });
    if (status === "quarantined") {
      await quarantineWorkerTask(registryRoot, created.run.run_id, { recorded_at: "2026-05-16T13:54:00.000Z", idempotency_key: `${head.worker_task_id}:quarantine` });
    } else {
      const completion = { worker_task_id: head.worker_task_id, purpose: head.purpose, epoch: head.epoch, attempt: head.attempt, authority: head.authority, status: status === "failed" ? "FAILED" : "COMPLETED", received_at: "2026-05-16T13:54:00.000Z", idempotency_key: `${head.worker_task_id}:${status}` };
      await recordWorkerCompletion(registryRoot, created.run.run_id, completion);
      await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:${status}:decision` });
    }
    const before = (await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath)).worker_tasks.head;
    const overdue = await recordWorkerTaskOverdue(registryRoot, created.run.run_id, { recorded_at: "2026-05-16T13:55:00.000Z", idempotency_key: `${head.worker_task_id}:overdue` });
    assert.equal(overdue.event.type, "worker_task.overdue_recorded");
    assert.equal(overdue.event.evidence.role, "implementer");
    assert.equal(overdue.run.worker_tasks.head.status, status);
    assert.deepEqual(overdue.run.worker_tasks.head, before);
  }
});

test("recovery replay of overdue event does not mutate terminal worker task truth", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_worker_overdue_recovery_terminal"), { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const head = await createDispatchedWorkerTask(registryRoot, created.run.run_id, { idSuffix: "failed-recovery" });
  const completion = { worker_task_id: head.worker_task_id, purpose: head.purpose, epoch: head.epoch, attempt: head.attempt, authority: head.authority, status: "FAILED", received_at: "2026-05-16T13:54:00.000Z", idempotency_key: `${head.worker_task_id}:failed` };
  await recordWorkerCompletion(registryRoot, created.run.run_id, completion);
  await recordWorkerCompletionDecision(registryRoot, created.run.run_id, { completion, decided_at: "2026-05-16T13:54:01.000Z", idempotency_key: `${head.worker_task_id}:failed:decision` });
  const before = await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath);
  await recordWorkerTaskOverdue(registryRoot, created.run.run_id, { recorded_at: "2026-05-16T13:55:00.000Z", idempotency_key: `${head.worker_task_id}:overdue` });

  const recovery = await recoverRegistry(registryRoot, { registryRepository, clock: () => new Date("2026-05-16T13:56:00.000Z") });
  const recovered = await readRunSnapshot(getRunPaths(registryRoot, created.run.run_id).runPath);
  assert.equal(recovery.summary.quarantined_runs, 0);
  assert.equal(recovered.worker_tasks.head.status, "failed");
  assert.deepEqual(recovered.worker_tasks.head, before.worker_tasks.head);
});
