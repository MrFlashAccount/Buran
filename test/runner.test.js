import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runBuranCli } from "../src/cli.js";
import { recoverRegistry } from "../src/recovery.js";
import { runLocalMission } from "../src/runner.js";
import { createRunFromPacketReport, getRunPaths, readEventsFile, readRunSnapshot, writeRunSnapshot } from "../src/registry-store.js";

const execFileAsync = promisify(execFile);

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "buran-runner-test-"));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function createLocalGitWorkspace(rootDir, branchName, { dirty = false } = {}) {
  const workspacePath = path.join(rootDir, `workspace-${branchName.replace(/[^a-z0-9._-]+/gi, "-")}`);
  await fs.mkdir(workspacePath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workspacePath });
  await fs.writeFile(path.join(workspacePath, "tracked.txt"), "local workspace\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspacePath });
  await execFileAsync("git", ["-c", "user.name=Test Runner", "-c", "user.email=test@example.com", "commit", "-m", "initial workspace"], { cwd: workspacePath });
  if (dirty) await fs.writeFile(path.join(workspacePath, "dirty.txt"), "dirty workspace\n", "utf8");
  return workspacePath;
}

function packetReport(runId = "run_runner_good", overrides = {}) {
  const taskId = overrides.taskId || "runner-good";
  const repo = overrides.repo || "MrFlashAccount/example-repo";
  const issueNumber = overrides.issueNumber ?? 92;
  const intendedBranch = overrides.intendedBranch || `sergey/${runId}`;
  const conflictSurface = overrides.conflictSurface || "src/runner";

  return {
    run_id: runId,
    task_id: taskId,
    source_path: "/tmp/runner-packets.json",
    packet_hash: `hash-${runId}`,
    raw: { task_id: taskId, approved: true },
    github: { repo, issue_number: issueNumber, intended_branch: intendedBranch },
    approval: { approved: true },
    sufficiency_status: "PASS",
    missing_fields: [],
    conflict_surface: [conflictSurface],
    sufficient: true,
  };
}

function weakPacketReport(runId = "run_runner_weak") {
  return {
    ...packetReport(runId),
    sufficiency_status: "FAIL",
    missing_fields: ["implementation.instructions"],
    sufficient: false,
  };
}

test("local runner stages queued run into waiting_for_lock and reruns idempotently without a lease", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_runner_waiting"), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  const first = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  assert.equal(first.mode, "run_local");
  assert.equal(first.outcome, "blocked");
  assert.equal(first.previous_state, "queued");
  assert.equal(first.current_state, "waiting_for_lock");
  assert.deepEqual(first.steps_taken.map((step) => [step.action, step.status, step.from_state, step.to_state]), [
    ["transition", "completed", "queued", "waiting_for_lock"],
  ]);
  assert.equal(first.blockers[0].code, "lease_required");

  const paths = getRunPaths(registryRoot, created.run.run_id);
  const snapshotAfterFirst = await readRunSnapshot(paths.runPath);
  const eventsAfterFirst = await readEventsFile(paths.eventsPath);
  assert.equal(snapshotAfterFirst.state, "waiting_for_lock");
  assert.equal(eventsAfterFirst.length, 3);

  const second = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  const eventsAfterSecond = await readEventsFile(paths.eventsPath);

  assert.equal(second.outcome, "blocked");
  assert.equal(second.previous_state, "waiting_for_lock");
  assert.equal(second.current_state, "waiting_for_lock");
  assert.deepEqual(second.steps_taken, []);
  assert.equal(second.blockers[0].code, "lease_required");
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length);
});

test("local runner can acquire a local lease when workspace info is provided and then stops before dispatch", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const intendedBranch = "sergey/run_runner_lease";
  const workspacePath = await createLocalGitWorkspace(tempDir, intendedBranch);
  const created = await createRunFromPacketReport(packetReport("run_runner_lease", { intendedBranch }), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  const first = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    workspaceId: "ws-runner",
    workspacePath,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  assert.equal(first.outcome, "blocked");
  assert.equal(first.previous_state, "queued");
  assert.equal(first.current_state, "running");
  assert.deepEqual(first.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["transition", "completed", "waiting_for_lock"],
    ["lease_acquire", "completed", "running"],
    ["workspace_preparation", "completed", "running"],
  ]);
  assert.equal(first.blockers[0].code, "implementation_dispatch_not_implemented");
  assert.equal(first.workspace_preparation.status, "prepared");
  assert.equal(first.workspace_preparation.artifact_record_status, "recorded");
  assert.match(first.workspace_preparation.artifact_ref.path, /^artifacts\/workspace-preparation\/[a-f0-9]{16}\.json$/);

  const paths = getRunPaths(registryRoot, created.run.run_id);
  const snapshotAfterFirst = await readRunSnapshot(paths.runPath);
  const eventsAfterFirst = await readEventsFile(paths.eventsPath);
  assert.equal(snapshotAfterFirst.state, "running");
  assert.equal(snapshotAfterFirst.workspace.id, "ws-runner");
  assert.equal(snapshotAfterFirst.workspace.lease_status, "acquired");
  assert.ok(eventsAfterFirst.some((event) => event.type === "lock.lease_acquired"));
  assert.ok(eventsAfterFirst.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "workspace_preparation"));
  assert.equal(await fs.readFile(path.join(paths.runDir, first.workspace_preparation.artifact_ref.path), "utf8").then((text) => text.includes("workspace-preparation.v1")), true);

  const second = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    workspaceId: "ws-runner",
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  const eventsAfterSecond = await readEventsFile(paths.eventsPath);

  assert.equal(second.outcome, "blocked");
  assert.equal(second.previous_state, "running");
  assert.equal(second.current_state, "running");
  assert.deepEqual(second.steps_taken.map((step) => [step.action, step.status, step.to_state]), [["workspace_preparation", "noop", "running"]]);
  assert.equal(second.blockers[0].code, "implementation_dispatch_not_implemented");
  assert.equal(second.workspace_preparation.artifact_record_status, "noop");
  assert.deepEqual(second.workspace_preparation.artifact_ref, first.workspace_preparation.artifact_ref);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length);

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T13:55:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 0);
});

test("local runner blocks running workspace preparation when workspace path is missing from the active lease snapshot", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const created = await createRunFromPacketReport(packetReport("run_runner_missing_workspace_path"), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    workspaceId: "ws-runner-missing-path",
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, created.run.run_id);
  const snapshot = await readRunSnapshot(paths.runPath);
  snapshot.workspace.path = null;
  await writeRunSnapshot(registryRoot, snapshot);

  const result = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });

  assert.equal(result.outcome, "blocked");
  assert.equal(result.current_state, "running");
  assert.equal(result.workspace_preparation.status, "blocked");
  assert.equal(result.workspace_preparation.blocker.code, "workspace_path_required");
  assert.equal(result.blockers[0].code, "workspace_path_required");
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(events.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "workspace_preparation"), false);
});

test("local runner records a new immutable workspace preparation artifact when local git evidence changes", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const intendedBranch = "sergey/run_runner_changed_workspace";
  const workspacePath = await createLocalGitWorkspace(tempDir, intendedBranch);
  const created = await createRunFromPacketReport(packetReport("run_runner_changed_workspace", { intendedBranch }), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  const first = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    workspaceId: "ws-runner-change",
    workspacePath,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });
  const paths = getRunPaths(registryRoot, created.run.run_id);
  const eventsAfterFirst = await readEventsFile(paths.eventsPath);

  await fs.writeFile(path.join(workspacePath, "new-untracked.txt"), "changed evidence\n", "utf8");

  const second = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  const eventsAfterSecond = await readEventsFile(paths.eventsPath);

  assert.equal(second.outcome, "blocked");
  assert.equal(second.workspace_preparation.status, "warning");
  assert.equal(second.workspace_preparation.artifact_record_status, "recorded");
  assert.notEqual(second.workspace_preparation.artifact_ref.path, first.workspace_preparation.artifact_ref.path);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length + 1);
  assert.ok(second.warnings.some((warning) => warning.code === "workspace_dirty"));
});

test("local runner blocks overlapping leases with structured blocked_lock_conflict", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const sharedPacket = {
    issueNumber: 133,
    intendedBranch: "sergey/runner-conflict",
    conflictSurface: "src/runner-conflict",
  };

  const firstCreated = await createRunFromPacketReport(packetReport("run_runner_conflict_a", { ...sharedPacket, taskId: "runner-conflict-a" }), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });
  const secondCreated = await createRunFromPacketReport(packetReport("run_runner_conflict_b", { ...sharedPacket, taskId: "runner-conflict-b" }), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  const first = await runLocalMission({
    registryRoot,
    runId: firstCreated.run.run_id,
    workspaceId: "ws-runner-a",
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  assert.equal(first.outcome, "blocked");
  assert.equal(first.current_state, "running");
  assert.deepEqual(first.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["transition", "completed", "waiting_for_lock"],
    ["lease_acquire", "completed", "running"],
  ]);

  const second = await runLocalMission({
    registryRoot,
    runId: secondCreated.run.run_id,
    workspaceId: "ws-runner-b",
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });

  assert.equal(second.outcome, "blocked");
  assert.equal(second.current_state, "blocked_lock_conflict");
  assert.deepEqual(second.steps_taken.map((step) => [step.action, step.status, step.to_state, step.conflicts || 0]), [
    ["transition", "completed", "waiting_for_lock", 0],
    ["lease_acquire", "blocked", "blocked_lock_conflict", 3],
  ]);
  assert.equal(second.blockers[0].code, "blocked_lock_conflict");
  assert.deepEqual([...new Set(second.blockers[0].conflicts.map((conflict) => conflict.surface))].sort(), ["branch", "conflict_surface", "issue"]);
  assert.equal(second.blockers[0].conflicts.every((conflict) => conflict.owner_run_id === firstCreated.run.run_id), true);
});

test("run CLI returns structured JSON for missing and terminal runs", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");

  const missing = await runBuranCli(["run", "--run", "run_missing", "--registry", registryRoot, "--json"]);
  assert.equal(missing.ok, true);
  const missingReport = JSON.parse(missing.text);
  assert.equal(missingReport.mode, "run_local");
  assert.equal(missingReport.outcome, "failed");
  assert.equal(missingReport.previous_state, null);
  assert.equal(missingReport.current_state, null);
  assert.equal(missingReport.blockers[0].code, "run_not_found");

  const weak = await createRunFromPacketReport(weakPacketReport("run_runner_terminal"), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });
  const terminal = await runBuranCli(["run", "--run", weak.run.run_id, "--registry", registryRoot, "--json"]);
  assert.equal(terminal.ok, true);
  const terminalReport = JSON.parse(terminal.text);
  assert.equal(terminalReport.outcome, "blocked");
  assert.equal(terminalReport.previous_state, "blocked_plan_insufficient");
  assert.equal(terminalReport.current_state, "blocked_plan_insufficient");
  assert.equal(terminalReport.blockers[0].code, "terminal_state");

  const textResult = await runBuranCli(["run", "--run", weak.run.run_id, "--registry", registryRoot]);
  assert.match(textResult.text, /buran: run local/);
  assert.match(textResult.text, /Blocker: terminal_state/);

  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.equal(activeRuns.runs.some((run) => run.run_id === weak.run.run_id), false);
});
