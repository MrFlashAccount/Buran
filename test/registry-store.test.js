import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SCHEMA_VERSION } from "../src/constants.js";
import { recoverRegistry } from "../src/recovery.js";
import { createRunFromPacketReport, getRunPaths, readEventsFile, readRunSnapshot, rebuildIndexes, transitionRun } from "../src/registry-store.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "buran-store-test-"));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function packetReport(runId = "run_store_good") {
  return {
    run_id: runId,
    task_id: "store-good",
    source_path: "/tmp/store-packets.json",
    packet_hash: "hash-store-good",
    raw: { task_id: "store-good", approved: true },
    github: { repo: "MrFlashAccount/example-repo", issue_number: 88, intended_branch: "sergey/store-good", base_branch: "develop" },
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

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T13:54:00.000Z") });

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

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T13:54:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "snapshot_event_state_mismatch");
});
