import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runBuranCli } from "../src/cli.js";
import { acquireWorkspaceLease } from "../src/locks.js";
import { recoverRegistry } from "../src/recovery.js";
import { runLocalMission } from "../src/runner.js";
import { createRunFromPacketReport, getRunPaths, readEventsFile, readRunSnapshot, recordArtifact, recordGateResult, transitionRun, writeRunSnapshot } from "../src/registry-store.js";

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

async function createVerificationWorkspace(rootDir, { testFile = "test/runner.test.js", passing = true, testScript = "", checkScript = "", testSource = "" } = {}) {
  const workspacePath = path.join(rootDir, `verification-workspace-${Math.random().toString(16).slice(2, 10)}`);
  await fs.mkdir(path.join(workspacePath, path.dirname(testFile)), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "package.json"), `${JSON.stringify({
    name: "buran-verification-workspace",
    private: true,
    type: "module",
    scripts: {
      test: testScript || `node --test ${testFile}`,
      check: checkScript || testScript || `node --test ${testFile}`,
    },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(workspacePath, testFile), testSource || [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `test("verification ${passing ? "passes" : "fails"}", () => { ${passing ? "assert.equal(1, 1);" : "assert.equal(1, 2);"} });`,
    "",
  ].join("\n"), "utf8");
  return workspacePath;
}

async function prepareVerificationRun(registryRoot, workspacePath, {
  runId = "run_runner_verification",
  commands = ["node --test test/runner.test.js"],
  taskId = "runner-verification",
  issueNumber = 192,
  reviewCriteria = ["Review the recorded verification artifact"],
  reviewerPlan = "",
} = {}) {
  const base = packetReport(runId, { taskId, issueNumber, conflictSurface: "src/verification" });
  const created = await createRunFromPacketReport({
    ...base,
    raw: {
      task_id: taskId,
      approved: true,
      github: {
        repo: base.github.repo,
        issue_number: base.github.issue_number,
        intended_branch: base.github.intended_branch,
      },
      scope: {
        goal: "Run local verification inside the approved packet envelope.",
        acceptance_criteria: ["Verification result is recorded locally"],
      },
      implementation: {
        instructions: "Implementation already completed in the leased workspace.",
      },
      verification: {
        commands,
      },
      review: {
        criteria: reviewCriteria,
        ...(reviewerPlan ? { reviewer_plan: reviewerPlan } : {}),
      },
      conflict_surface: base.conflict_surface,
    },
  }, {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });

  await acquireWorkspaceLease(registryRoot, created.run.run_id, {
    workspaceId: `ws-${runId}`,
    workspacePath,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });
  await transitionRun(registryRoot, created.run.run_id, {
    toState: "verification",
    actor: "runner-verification-test",
    evidence: { reason: "implementation completed" },
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  return created.run.run_id;
}

async function advanceRunToInternalReview(registryRoot, runId, timestamp = "2026-05-16T13:55:00.000Z") {
  return runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date(timestamp),
  });
}

async function seedInternalReviewGateResult(registryRoot, runId, {
  status = "PASS",
  summary = `Seeded internal review ${status}`,
  problem = null,
  recordedAt = "2026-05-16T13:56:00.000Z",
} = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const executionEpoch = snapshot.execution.current_epoch;
  const gateAttempt = (snapshot.gates.internal_review.current_attempt || 0) + 1;
  const artifact = await recordArtifact(registryRoot, runId, {
    artifactPath: `artifacts/internal-review/seed-${status.toLowerCase()}-${runId}.json`,
    content: `${JSON.stringify({
      schema_version: "internal-review-report.v1",
      status,
      summary,
      problem,
    }, null, 2)}\n`,
    gate_name: "internal_review",
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    recorded_from_state: "internal_review",
    actor: "runner-test-seed-review",
    recorded_at: recordedAt,
    provenance: { kind: "internal-review-report" },
  });

  const gateResult = await recordGateResult(registryRoot, runId, {
    gate_name: "internal_review",
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    recorded_from_state: "internal_review",
    status,
    artifact_refs: [artifact.artifact_ref],
    recorded_at: recordedAt,
    actor: "runner-test-seed-review",
    idempotency_key: `${runId}:internal_review:${executionEpoch}:${gateAttempt}:${status.toLowerCase()}`,
  });

  return { artifact, gateResult };
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
    ["implementation_dispatch", "completed", "running"],
  ]);
  assert.equal(first.blockers[0].code, "implementation_dispatch_not_implemented");
  assert.equal(first.blockers[0].dispatch_status, "dispatch_ready_not_started");
  assert.equal(first.workspace_preparation.status, "prepared");
  assert.equal(first.workspace_preparation.artifact_record_status, "recorded");
  assert.match(first.workspace_preparation.artifact_ref.path, /^artifacts\/workspace-preparation\/[a-f0-9]{16}\.json$/);
  assert.equal(first.implementation_dispatch.status, "dispatch_ready_not_started");
  assert.equal(first.implementation_dispatch.artifact_record_status, "recorded");
  assert.match(first.implementation_dispatch.artifact_ref.path, /^artifacts\/implementation-dispatch\/[a-f0-9]{16}\.json$/);
  assert.deepEqual(first.implementation_dispatch.workspace_preparation_artifact_ref, first.workspace_preparation.artifact_ref);

  const paths = getRunPaths(registryRoot, created.run.run_id);
  const snapshotAfterFirst = await readRunSnapshot(paths.runPath);
  const eventsAfterFirst = await readEventsFile(paths.eventsPath);
  assert.equal(snapshotAfterFirst.state, "running");
  assert.equal(snapshotAfterFirst.workspace.id, "ws-runner");
  assert.equal(snapshotAfterFirst.workspace.lease_status, "acquired");
  assert.equal(snapshotAfterFirst.gates.verification.status, "PENDING");
  assert.equal(snapshotAfterFirst.gates.internal_review.status, "PENDING");
  assert.ok(eventsAfterFirst.some((event) => event.type === "lock.lease_acquired"));
  assert.ok(eventsAfterFirst.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "workspace_preparation"));
  assert.ok(eventsAfterFirst.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "implementation_dispatch"));
  assert.equal(eventsAfterFirst.some((event) => event.type === "gate.result_recorded"), false);
  assert.equal(await fs.readFile(path.join(paths.runDir, first.workspace_preparation.artifact_ref.path), "utf8").then((text) => text.includes("workspace-preparation.v1")), true);
  const dispatchArtifact = JSON.parse(await fs.readFile(path.join(paths.runDir, first.implementation_dispatch.artifact_ref.path), "utf8"));
  assert.equal(dispatchArtifact.schema_version, "implementation-dispatch-intent.v1");
  assert.equal(dispatchArtifact.dispatch_status, "dispatch_not_started");
  assert.deepEqual(dispatchArtifact.workspace_preparation_artifact, first.workspace_preparation.artifact_ref);
  assert.deepEqual(dispatchArtifact.packet_artifact, snapshotAfterFirst.artifacts.packet);

  const workspacePreparationArtifactPath = path.join(paths.runDir, first.workspace_preparation.artifact_ref.path);
  const dispatchArtifactPath = path.join(paths.runDir, first.implementation_dispatch.artifact_ref.path);
  await fs.rm(workspacePreparationArtifactPath, { force: true });
  await fs.rm(dispatchArtifactPath, { force: true });

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
  assert.deepEqual(second.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["workspace_preparation", "noop", "running"],
    ["implementation_dispatch", "noop", "running"],
  ]);
  assert.equal(second.blockers[0].code, "implementation_dispatch_not_implemented");
  assert.equal(second.workspace_preparation.artifact_record_status, "noop");
  assert.deepEqual(second.workspace_preparation.artifact_ref, first.workspace_preparation.artifact_ref);
  assert.equal(second.implementation_dispatch.status, "dispatch_ready_not_started");
  assert.equal(second.implementation_dispatch.artifact_record_status, "noop");
  assert.deepEqual(second.implementation_dispatch.artifact_ref, first.implementation_dispatch.artifact_ref);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length);
  assert.equal(await fs.readFile(workspacePreparationArtifactPath, "utf8").then((text) => text.includes("workspace-preparation.v1")), true);
  const recoveredDispatchArtifact = JSON.parse(await fs.readFile(dispatchArtifactPath, "utf8"));
  assert.equal(recoveredDispatchArtifact.schema_version, "implementation-dispatch-intent.v1");
  assert.equal(recoveredDispatchArtifact.dispatch_status, "dispatch_not_started");
  assert.deepEqual(recoveredDispatchArtifact.workspace_preparation_artifact, first.workspace_preparation.artifact_ref);
  assert.deepEqual(recoveredDispatchArtifact.packet_artifact, snapshotAfterFirst.artifacts.packet);

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
  assert.equal(result.implementation_dispatch, null);
  assert.equal(result.blockers[0].code, "workspace_path_required");
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(events.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "workspace_preparation"), false);
  assert.equal(events.some((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "implementation_dispatch"), false);
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
  const snapshotAfterFirst = await readRunSnapshot(paths.runPath);
  const eventsAfterFirst = await readEventsFile(paths.eventsPath);

  await fs.writeFile(path.join(workspacePath, "new-untracked.txt"), "changed evidence\n", "utf8");

  const second = await runLocalMission({
    registryRoot,
    runId: created.run.run_id,
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  const eventsAfterSecond = await readEventsFile(paths.eventsPath);
  const snapshotAfterSecond = await readRunSnapshot(paths.runPath);

  assert.equal(second.outcome, "blocked");
  assert.equal(second.workspace_preparation.status, "warning");
  assert.equal(second.workspace_preparation.artifact_record_status, "recorded");
  assert.notEqual(second.workspace_preparation.artifact_ref.path, first.workspace_preparation.artifact_ref.path);
  assert.equal(second.implementation_dispatch.status, "dispatch_ready_not_started");
  assert.equal(second.implementation_dispatch.artifact_record_status, "recorded");
  assert.notEqual(second.implementation_dispatch.artifact_ref.path, first.implementation_dispatch.artifact_ref.path);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length + 2);
  assert.equal(snapshotAfterFirst.updated_at, "2026-05-16T13:53:00.000Z");
  assert.equal(snapshotAfterSecond.updated_at, "2026-05-16T13:54:00.000Z");
  assert.deepEqual(eventsAfterSecond.slice(-2).map((event) => event.timestamp), ["2026-05-16T13:54:00.000Z", "2026-05-16T13:54:00.000Z"]);
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

test("local runner executes allowlisted verification, records the gate ledger, and advances to internal_review", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_verification_pass",
  });

  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.previous_state, "verification");
  assert.equal(result.current_state, "internal_review");
  assert.deepEqual(result.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["verification_artifact", "completed", "verification"],
    ["gate_result_recorded", "completed", "verification"],
    ["transition", "completed", "internal_review"],
  ]);
  assert.equal(result.verification.status, "PASS");
  assert.equal(result.verification.command_results[0].status, "PASS");
  assert.match(result.verification.artifact_ref.path, /^artifacts\/verification\/[a-f0-9]{16}\.json$/);

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "internal_review");
  assert.equal(snapshot.gates.verification.status, "PASS");
  assert.equal(snapshot.gates.verification.current_epoch, 1);
  assert.equal(snapshot.gates.verification.current_attempt, 1);
  assert.equal(events.filter((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "verification").length, 1);
  assert.equal(events.filter((event) => event.type === "gate.result_recorded").length, 1);
  assert.equal(events.at(-1).state_after, "internal_review");

  const verificationArtifact = JSON.parse(await fs.readFile(path.join(paths.runDir, result.verification.artifact_ref.path), "utf8"));
  assert.equal(verificationArtifact.schema_version, "verification-report.v1");
  assert.equal(verificationArtifact.status, "PASS");
  assert.deepEqual(verificationArtifact.packet_verification.commands, ["node --test test/runner.test.js"]);
});

test("local runner reuses a recorded verification result without duplicating gate events", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_verification_resume",
  });

  await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const eventsBeforeRetry = await readEventsFile(paths.eventsPath);
  await writeRunSnapshot(registryRoot, {
    ...snapshot,
    state: "verification",
    updated_at: "2026-05-16T13:55:30.000Z",
  });

  const retried = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });
  const eventsAfterRetry = await readEventsFile(paths.eventsPath);

  assert.equal(retried.outcome, "completed");
  assert.equal(retried.current_state, "internal_review");
  assert.equal(retried.verification.status, "PASS");
  assert.equal(retried.verification.resumed_recorded_result, true);
  assert.deepEqual(retried.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["verification_resume", "noop", "verification"],
    ["transition", "completed", "internal_review"],
  ]);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "gate.result_recorded").length, 1);
  assert.equal(eventsAfterRetry.length, eventsBeforeRetry.length + 1);
});

test("local runner blocks verification resume when the recorded artifact is missing", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_verification_resume_missing_artifact",
  });

  const first = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, runId);
  const verificationArtifactPath = path.join(paths.runDir, first.verification.artifact_ref.path);
  await fs.rm(verificationArtifactPath, { force: true });
  const snapshot = await readRunSnapshot(paths.runPath);
  const eventsBeforeRetry = await readEventsFile(paths.eventsPath);
  await writeRunSnapshot(registryRoot, {
    ...snapshot,
    state: "verification",
    updated_at: "2026-05-16T13:55:30.000Z",
  });

  const retried = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });
  const eventsAfterRetry = await readEventsFile(paths.eventsPath);

  assert.equal(retried.outcome, "blocked");
  assert.equal(retried.current_state, "verification");
  assert.equal(retried.verification.status, "PASS");
  assert.equal(retried.verification.resumed_recorded_result, false);
  assert.equal(retried.verification.gate_result_status, "stale_recorded_result");
  assert.equal(retried.verification.problem.code, "verification_artifact_missing");
  assert.deepEqual(retried.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["verification_resume", "blocked", "verification"],
  ]);
  assert.equal(eventsAfterRetry.length, eventsBeforeRetry.length);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "gate.result_recorded").length, 1);
});

test("local runner executes verification with a minimal environment and does not inherit caller secrets", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const previousSecret = process.env.BURAN_TEST_SECRET;
  process.env.BURAN_TEST_SECRET = "top-secret-value";

  try {
    const workspacePath = await createVerificationWorkspace(tempDir, {
      testFile: "test/runner.test.js",
      testSource: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("verification env is minimal", () => {',
        '  assert.equal(process.env.BURAN_TEST_SECRET, undefined);',
        '});',
        "",
      ].join("\n"),
    });
    const runId = await prepareVerificationRun(registryRoot, workspacePath, {
      runId: "run_runner_verification_minimal_env",
    });

    const result = await runLocalMission({
      registryRoot,
      runId,
      clock: () => new Date("2026-05-16T13:55:00.000Z"),
    });

    assert.equal(result.outcome, "completed");
    assert.equal(result.current_state, "internal_review");
    assert.equal(result.verification.status, "PASS");
  } finally {
    if (previousSecret === undefined) delete process.env.BURAN_TEST_SECRET;
    else process.env.BURAN_TEST_SECRET = previousSecret;
  }
});

test("local runner records FAIL verification results and advances to fix_loop", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: false,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_verification_fail",
    commands: ["node --test test/runner.test.js"],
  });

  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.current_state, "fix_loop");
  assert.equal(result.verification.status, "FAIL");
  assert.equal(result.verification.command_results[0].status, "FAIL");

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "fix_loop");
  assert.equal(snapshot.gates.verification.status, "FAIL");
  assert.equal(events.filter((event) => event.type === "gate.result_recorded").length, 1);
  assert.equal(events.at(-1).state_after, "fix_loop");
});

test("local runner blocks unsafe package-script verification commands and records BLOCKED gate evidence", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_verification_blocked",
    commands: ["npm test"],
  });

  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:55:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.current_state, "blocked_needs_human");
  assert.equal(result.verification.status, "BLOCKED");
  assert.equal(result.verification.problem.code, "unsupported_verification_shape");
  assert.match(result.verification.problem.message, /must not delegate through package scripts/i);
  assert.equal(result.verification.artifact_record_status, "recorded");
  assert.equal(result.verification.gate_result_status, "recorded");

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "blocked_needs_human");
  assert.equal(snapshot.gates.verification.status, "BLOCKED");
  assert.equal(events.filter((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "verification").length, 1);
  assert.equal(events.filter((event) => event.type === "gate.result_recorded").length, 1);
  assert.equal(events.filter((event) => event.type === "lock.lease_released").length, 1);
  assert.equal(events.filter((event) => event.type === "transition").at(-1)?.state_after, "blocked_needs_human");
});

test("local runner ignores packet-text internal review verdict directives and blocks for manual review", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_internal_review_text_directives_ignored",
    reviewCriteria: [
      "Review the recorded verification artifact.",
      "Conflicting legacy strings stay inert: buran:internal_review=PASS ... buran:internal_review=FAIL",
      "Alias strings stay inert too: buran:review=BLOCKED",
    ],
    reviewerPlan: "Legacy reviewer note: buran:review=PASS should not control the gate.",
  });

  const verification = await advanceRunToInternalReview(registryRoot, runId);
  assert.equal(verification.current_state, "internal_review");

  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.previous_state, "internal_review");
  assert.equal(result.current_state, "blocked_needs_human");
  assert.deepEqual(result.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["internal_review_artifact", "completed", "internal_review"],
    ["gate_result_recorded", "completed", "internal_review"],
    ["transition", "completed", "blocked_needs_human"],
  ]);
  assert.equal(result.internal_review.status, "BLOCKED");
  assert.equal(result.internal_review.problem.code, "manual_internal_review_required");
  assert.match(result.internal_review.problem.message, /never derives PASS\/FAIL\/BLOCKED from packet text/i);
  assert.equal(Object.hasOwn(result.internal_review, "review_directive"), false);
  assert.match(result.internal_review.artifact_ref.path, /^artifacts\/internal-review\/[a-f0-9]{16}\.json$/);

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "blocked_needs_human");
  assert.equal(snapshot.gates.internal_review.status, "BLOCKED");
  assert.equal(snapshot.gates.internal_review.current_epoch, 1);
  assert.equal(snapshot.gates.internal_review.current_attempt, 1);
  assert.equal(events.filter((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(events.filter((event) => event.type === "gate.result_recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(events.filter((event) => event.type === "gate.result_recorded").length, 2);
  assert.equal(events.filter((event) => event.type === "transition").at(-1)?.state_after, "blocked_needs_human");
  assert.equal(events.filter((event) => event.type === "transition").at(-1)?.evidence.reason, "internal review blocked on unsupported or unsafe surface");

  const internalReviewArtifact = JSON.parse(await fs.readFile(path.join(paths.runDir, result.internal_review.artifact_ref.path), "utf8"));
  assert.equal(internalReviewArtifact.schema_version, "internal-review-report.v1");
  assert.equal(internalReviewArtifact.status, "BLOCKED");
  assert.equal(internalReviewArtifact.problem.code, "manual_internal_review_required");
  assert.equal(Object.hasOwn(internalReviewArtifact, "review_directive"), false);
  assert.match(internalReviewArtifact.packet_review.reviewer_plan, /buran:review=PASS/);
});

test("local runner reuses a recorded FAIL internal review result and advances to fix_loop", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_internal_review_fail",
  });

  await advanceRunToInternalReview(registryRoot, runId);
  await seedInternalReviewGateResult(registryRoot, runId, {
    status: "FAIL",
    summary: "Seeded failing internal review",
  });
  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.current_state, "fix_loop");
  assert.equal(result.internal_review.status, "FAIL");
  assert.equal(result.internal_review.resumed_recorded_result, true);
  assert.equal(result.internal_review.summary, "Seeded failing internal review");

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "fix_loop");
  assert.equal(snapshot.gates.internal_review.status, "FAIL");
  assert.equal(events.filter((event) => event.type === "gate.result_recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(events.at(-1).state_after, "fix_loop");
  assert.equal(events.at(-1).evidence.reason, "internal review failed inside approved scope");
});

test("local runner reuses a recorded BLOCKED internal review result and advances to blocked_needs_human", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_internal_review_blocked",
  });

  await advanceRunToInternalReview(registryRoot, runId);
  await seedInternalReviewGateResult(registryRoot, runId, {
    status: "BLOCKED",
    summary: "Seeded blocked internal review",
    problem: {
      code: "manual_internal_review_required",
      message: "Manual review evidence still required.",
    },
  });
  const result = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.current_state, "blocked_needs_human");
  assert.equal(result.internal_review.status, "BLOCKED");
  assert.equal(result.internal_review.resumed_recorded_result, true);
  assert.equal(result.internal_review.problem.code, "manual_internal_review_required");

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const events = await readEventsFile(paths.eventsPath);
  assert.equal(snapshot.state, "blocked_needs_human");
  assert.equal(snapshot.gates.internal_review.status, "BLOCKED");
  assert.equal(events.filter((event) => event.type === "artifact.recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(events.filter((event) => event.type === "gate.result_recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(events.filter((event) => event.type === "transition").at(-1)?.state_after, "blocked_needs_human");
  assert.equal(events.filter((event) => event.type === "transition").at(-1)?.evidence.reason, "internal review blocked on unsupported or unsafe surface");
});

test("local runner reuses a recorded internal review result without duplicating gate events", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_internal_review_resume",
  });

  await advanceRunToInternalReview(registryRoot, runId);
  await seedInternalReviewGateResult(registryRoot, runId, {
    status: "PASS",
    summary: "Seeded passing internal review",
  });
  await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:56:00.000Z"),
  });

  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  const eventsBeforeRetry = await readEventsFile(paths.eventsPath);
  await writeRunSnapshot(registryRoot, {
    ...snapshot,
    state: "internal_review",
    updated_at: "2026-05-16T13:56:30.000Z",
  });

  const retried = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
  });
  const eventsAfterRetry = await readEventsFile(paths.eventsPath);

  assert.equal(retried.outcome, "completed");
  assert.equal(retried.current_state, "pr_ready");
  assert.equal(retried.internal_review.status, "PASS");
  assert.equal(retried.internal_review.resumed_recorded_result, true);
  assert.deepEqual(retried.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["internal_review_resume", "noop", "internal_review"],
    ["transition", "completed", "pr_ready"],
  ]);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "gate.result_recorded" && event.evidence.gate_name === "internal_review").length, 1);
  assert.equal(eventsAfterRetry.length, eventsBeforeRetry.length + 1);
});

test("local runner blocks internal review resume when the recorded artifact is missing", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const workspacePath = await createVerificationWorkspace(tempDir, {
    testFile: "test/runner.test.js",
    passing: true,
  });
  const runId = await prepareVerificationRun(registryRoot, workspacePath, {
    runId: "run_runner_internal_review_resume_missing_artifact",
  });

  await advanceRunToInternalReview(registryRoot, runId);
  const seeded = await seedInternalReviewGateResult(registryRoot, runId, {
    status: "PASS",
    summary: "Seeded passing internal review",
  });

  const paths = getRunPaths(registryRoot, runId);
  const internalReviewArtifactPath = path.join(paths.runDir, seeded.artifact.artifact_ref.path);
  await fs.rm(internalReviewArtifactPath, { force: true });
  const snapshot = await readRunSnapshot(paths.runPath);
  const eventsBeforeRetry = await readEventsFile(paths.eventsPath);
  await writeRunSnapshot(registryRoot, {
    ...snapshot,
    state: "internal_review",
    updated_at: "2026-05-16T13:56:30.000Z",
  });

  const retried = await runLocalMission({
    registryRoot,
    runId,
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
  });
  const eventsAfterRetry = await readEventsFile(paths.eventsPath);

  assert.equal(retried.outcome, "blocked");
  assert.equal(retried.current_state, "internal_review");
  assert.equal(retried.internal_review.status, "PASS");
  assert.equal(retried.internal_review.resumed_recorded_result, false);
  assert.equal(retried.internal_review.gate_result_status, "stale_recorded_result");
  assert.equal(retried.internal_review.problem.code, "internal_review_artifact_missing");
  assert.deepEqual(retried.steps_taken.map((step) => [step.action, step.status, step.to_state]), [
    ["internal_review_resume", "blocked", "internal_review"],
  ]);
  assert.equal(eventsAfterRetry.length, eventsBeforeRetry.length);
  assert.equal(eventsAfterRetry.filter((event) => event.type === "gate.result_recorded" && event.evidence.gate_name === "internal_review").length, 1);
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
