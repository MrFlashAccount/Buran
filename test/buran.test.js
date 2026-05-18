import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBuranCli } from "../src/cli.js";
import { SCHEMA_VERSION } from "../src/constants.js";
import { intakePacketListFile, validatePacketListFile } from "../src/buran.js";
import { validateRunSnapshot } from "../src/execution-run-schema.js";
import { acquireWorkspaceLease, getLeaseRecordPath } from "../src/locks.js";
import { normalizeObservabilityConfig, sanitizeForObservability, sanitizePathForOutput, sanitizePublicReportForOutput } from "../src/observability.js";
import { buildLocalPrProjection } from "../src/pr-projection-adapter.js";
import { recoverRegistry } from "../src/recovery.js";
import { transitionRun, writeJsonAtomic } from "../src/registry.js";
import { validateTransition } from "../src/state-machine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "packet-list.mixed.json");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "buran-test-"));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function goodPacket({ taskId, issue, branch, conflictSurface, repo = "MrFlashAccount/example-repo" }) {
  return {
    task_id: taskId,
    approved: true,
    github: {
      repo,
      issue_number: issue,
      intended_branch: branch,
    },
    scope: {
      goal: `Execute ${taskId} inside its approved envelope.`,
      acceptance_criteria: ["Local lock behavior is deterministic"],
    },
    implementation: {
      instructions: "Use local Buran state only. Do not contact GitHub.",
    },
    verification: {
      commands: ["npm test"],
    },
    review: {
      criteria: ["Confirm lock behavior stays local-only"],
    },
    conflict_surface: Array.isArray(conflictSurface) ? conflictSurface : [conflictSurface],
  };
}

function projectionReadySnapshot() {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: "run_projection_ready",
    task_id: "projection-ready",
    github: {
      repo: "MrFlashAccount/example-repo",
      issue_number: 17,
      intended_branch: "sergey/feature",
      base_branch: "develop",
      pr: {
        number: 123456,
        url: "local://github-pr/example/pull/123456",
        repo: "MrFlashAccount/example-repo",
        issue_number: 17,
        head_branch: "sergey/feature",
        base_branch: "develop",
        state: "open",
        draft: false,
        title: "Buran handoff for feature",
        projection_mode: "local_fake",
        projected_at: "2026-05-16T13:57:00.000Z",
        actor: "runner-test",
      },
    },
    packet: {
      hash: "hash-projection-ready",
      source_path: "/tmp/projection-ready.json",
      approval: { approved: true },
      sufficiency_status: "PASS",
      missing_fields: [],
    },
    state: "ready_for_manual_review",
    last_sequence: 7,
    execution: { current_epoch: 1 },
    workspace: { id: null, path: null, lease_status: "released" },
    locks: {
      repo: "MrFlashAccount/example-repo",
      issue: 17,
      branch: "sergey/feature",
      conflict_surface: ["src/feature"],
      lease_status: "released",
    },
    gates: {
      verification: {
        status: "PASS",
        current_epoch: 1,
        current_attempt: 1,
        recorded_from_state: "verification",
        artifact_refs: [{ path: "artifacts/verification/report.json", sha256: "a".repeat(64) }],
        recorded_at: "2026-05-16T13:55:00.000Z",
        actor: "verification-test",
        idempotency_key: "run:verification:1",
      },
      internal_review: {
        status: "PASS",
        current_epoch: 1,
        current_attempt: 1,
        recorded_from_state: "internal_review",
        artifact_refs: [{ path: "artifacts/internal-review/report.json", sha256: "b".repeat(64) }],
        recorded_at: "2026-05-16T13:56:00.000Z",
        actor: "review-test",
        idempotency_key: "run:internal-review:1",
      },
    },
    artifacts: {
      packet: { path: "artifacts/packet.md", sha256: "c".repeat(64) },
      recorded: { by_path: {} },
    },
    projections: {
      github_pr: {
        projection_name: "github_pr",
        projection_target: "github.pr",
        adapter: "local-github-pr-projection",
        mode: "local_fake",
        execution_epoch: 1,
        recorded_from_state: "pr_ready",
        last_intent: {
          artifact_ref: { path: "artifacts/pr/projection-intent-abc123.json", sha256: "d".repeat(64) },
          recorded_at: "2026-05-16T13:57:00.000Z",
          actor: "runner-test",
          idempotency_key: "run:projection:intent",
          execution_epoch: 1,
          recorded_from_state: "pr_ready",
          sequence: 5,
        },
        last_result: {
          status: "projected_local",
          artifact_ref: { path: "artifacts/pr/projection-result-abc123.json", sha256: "e".repeat(64) },
          recorded_at: "2026-05-16T13:57:00.000Z",
          actor: "runner-test",
          idempotency_key: "run:projection:result",
          intent_idempotency_key: "run:projection:intent",
          execution_epoch: 1,
          recorded_from_state: "pr_ready",
          sequence: 6,
          github_pr: {
            number: 123456,
            url: "local://github-pr/example/pull/123456",
            repo: "MrFlashAccount/example-repo",
            issue_number: 17,
            head_branch: "sergey/feature",
            base_branch: "develop",
            state: "open",
            draft: false,
            title: "Buran handoff for feature",
            projection_mode: "local_fake",
            projected_at: "2026-05-16T13:57:00.000Z",
            actor: "runner-test",
          },
        },
      },
    },
    created_at: "2026-05-16T13:52:00.000Z",
    updated_at: "2026-05-16T13:57:00.000Z",
    terminal_reason: "PR handoff recorded",
  };
}

async function writePacketList(tempDir, packets) {
  const packetPath = path.join(tempDir, "packets.json");
  await fs.writeFile(packetPath, `${JSON.stringify({ packets }, null, 2)}\n`, "utf8");
  return packetPath;
}

const GITHUB_PAT_SECRET = "github_pat_1234567890abcdefghijklmnop";
const GHP_SECRET = "ghp_1234567890abcdefghijklmnop";
const GLPAT_SECRET = "glpat-1234567890abcdefghijklmnop";

function assertPublicOutputRedactsSyntheticSecrets(text) {
  assert.doesNotMatch(text, new RegExp(escapeRegExp(GITHUB_PAT_SECRET)));
  assert.doesNotMatch(text, new RegExp(escapeRegExp(GHP_SECRET)));
  assert.doesNotMatch(text, new RegExp(escapeRegExp(GLPAT_SECRET)));
  assert.match(text, /\[REDACTED_SECRET\]/);
}

async function listLeaseRecordFiles(registryRoot) {
  const dir = path.join(registryRoot, "leases");
  const entries = await fs.readdir(dir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((name) => name.endsWith(".json")).sort();
}

test("dry validation uses only an explicit packet list and does not create a registry", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");

  const result = await runBuranCli(["validate", "--packets", fixturePath, "--registry", registryRoot, "--json"]);

  assert.equal(result.ok, true);
  assert.equal(result.report.mode, "dry_validation");
  assert.equal(result.report.registry_written, false);
  assert.equal(result.report.summary.total, 2);
  assert.equal(result.report.summary.sufficient, 1);
  assert.equal(result.report.summary.insufficient, 1);
  assert.equal(result.report.summary.autonomous_discovery, false);
  assert.equal(result.report.summary.remote_writes, false);
  assert.equal(result.report.summary.task_execution, false);
  assert.equal(await pathExists(registryRoot), false);
});

test("plugin entrypoint imports locally and registers the buran command", async () => {
  const module = await import("../index.js");
  const entry = module.default;
  const commands = [];

  entry.register({
    pluginConfig: {},
    registerCommand(command) {
      commands.push(command);
    },
  });

  assert.equal(entry.id, "buran");
  assert.equal(entry.configSchema.type, "object");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "buran");

  const result = await commands[0].handler({ args: ["validate", "--packets", fixturePath, "--json"] });
  const report = JSON.parse(result.text);
  assert.equal(report.mode, "dry_validation");
  assert.equal(report.registry_written, false);
});

test("missing --packets is rejected instead of discovering tasks autonomously", async () => {
  const result = await runBuranCli(["validate"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /--packets <path> is required/);
  assert.match(result.text, /autonomous task discovery is not supported/);
});

test("intake creates local JSON runs, packet artifacts, and transition event journals", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const fixedDate = new Date("2026-05-16T13:52:00.000Z");

  const report = await intakePacketListFile(fixturePath, {
    registryRoot,
    clock: () => fixedDate,
  });

  assert.equal(report.mode, "intake");
  assert.equal(report.registry_written, true);
  assert.equal(report.runs.length, 2);
  assert.equal(report.batch.selected_count, 2);
  assert.equal(report.batch.accepted_count, 1);
  assert.equal(report.batch.blocked_count, 1);
  assert.equal(path.basename(report.batch.batch_path), "batch.json");

  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  const blockedRun = report.runs.find((run) => run.task_id === "weak-task-18");
  assert.ok(queuedRun);
  assert.ok(blockedRun);
  assert.equal(queuedRun.state, "queued");
  assert.equal(blockedRun.state, "blocked_plan_insufficient");

  const batchSnapshot = await readJson(report.batch.batch_path);
  assert.equal(batchSnapshot.schema_version, SCHEMA_VERSION);
  assert.equal(batchSnapshot.batch_id, report.batch.batch_id);
  assert.equal(batchSnapshot.created_at, fixedDate.toISOString());
  assert.equal(batchSnapshot.source.kind, "packet_list");
  assert.equal(batchSnapshot.source.path, fixturePath);
  assert.equal(batchSnapshot.input_summary.packet_count, 2);
  assert.deepEqual(batchSnapshot.selected.run_ids, report.runs.map((run) => run.run_id));
  assert.deepEqual(batchSnapshot.accepted.run_ids, [queuedRun.run_id]);
  assert.deepEqual(batchSnapshot.blocked.run_ids, [blockedRun.run_id]);
  assert.equal(batchSnapshot.config.autonomous_discovery, false);
  assert.equal(batchSnapshot.config.remote_writes, false);
  assert.equal(batchSnapshot.config.task_execution, false);

  const queuedSnapshot = await readJson(path.join(queuedRun.run_dir, "run.json"));
  assert.equal(queuedSnapshot.schema_version, SCHEMA_VERSION);
  assert.equal(queuedSnapshot.state, "queued");
  assert.deepEqual(queuedSnapshot.gates.verification, {
    status: "PENDING",
    current_epoch: 0,
    current_attempt: 0,
    recorded_from_state: "",
    artifact_refs: [],
    recorded_at: null,
    actor: "",
    idempotency_key: "",
  });
  assert.deepEqual(queuedSnapshot.gates.internal_review, queuedSnapshot.gates.verification);
  assert.equal(queuedSnapshot.last_sequence, 2);
  assert.equal(queuedSnapshot.execution.current_epoch, 0);
  assert.deepEqual(queuedSnapshot.projections, {});
  assert.equal(queuedSnapshot.github.pr, null);
  assert.equal(queuedSnapshot.workspace.lease_status, "not_requested");
  assert.equal(queuedSnapshot.locks.lease_status, "not_requested");

  const queuedEvents = await readJsonLines(path.join(queuedRun.run_dir, "events.jsonl"));
  assert.deepEqual(queuedEvents.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(queuedEvents.map((event) => event.state_after), ["packet_received", "queued"]);
  assert.equal(queuedEvents[0].actor, "packet-intake");

  const packetArtifactPath = path.join(queuedRun.run_dir, queuedSnapshot.artifacts.packet.path);
  const artifactText = await fs.readFile(packetArtifactPath, "utf8");
  assert.match(artifactText, /Approved packet snapshot/);
  assert.match(artifactText, /good-task-17/);
});

test("insufficient packets become terminal blocked_plan_insufficient runs with evidence", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const blockedRun = report.runs.find((run) => run.task_id === "weak-task-18");

  const snapshot = await readJson(path.join(blockedRun.run_dir, "run.json"));
  const events = await readJsonLines(path.join(blockedRun.run_dir, "events.jsonl"));

  assert.equal(snapshot.state, "blocked_plan_insufficient");
  assert.equal(snapshot.packet.sufficiency_status, "FAIL");
  assert.ok(snapshot.packet.missing_fields.includes("approval.approved"));
  assert.ok(snapshot.packet.missing_fields.includes("github.intended_branch"));
  assert.ok(snapshot.packet.missing_fields.includes("implementation.instructions"));
  assert.match(snapshot.terminal_reason, /Packet insufficient/);
  assert.equal(events.at(-1).state_after, "blocked_plan_insufficient");
  assert.deepEqual(events.at(-1).evidence.missing_fields, snapshot.packet.missing_fields);

  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.equal(activeRuns.runs.some((run) => run.run_id === blockedRun.run_id), false);
});

test("dry validation reports non-object packets as structured validation failures", async () => {
  const tempDir = await makeTempDir();
  const packetPath = await writePacketList(tempDir, [null, 42, ["array-packet"], "text-packet"]);

  const report = await validatePacketListFile(packetPath);

  assert.equal(report.mode, "dry_validation");
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.sufficient, 0);
  assert.equal(report.summary.insufficient, 4);
  assert.deepEqual(report.packets.map((packet) => packet.task_id), ["packet-1", "packet-2", "packet-3", "packet-4"]);
  for (const packet of report.packets) {
    assert.equal(packet.sufficiency_status, "FAIL");
    assert.equal(packet.sufficient, false);
    assert.deepEqual(packet.missing_fields, ["packet_object"]);
    assert.match(packet.run_id, /^run_packet-\d+_[a-f0-9]{12}$/);
    assert.deepEqual(packet.github, {});
    assert.deepEqual(packet.conflict_surface, []);
  }
});

test("intake blocks non-object packets instead of crashing", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [null, 42, ["array-packet"], "text-packet"]);

  const report = await intakePacketListFile(packetPath, { registryRoot });

  assert.equal(report.mode, "intake");
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.sufficient, 0);
  assert.equal(report.summary.insufficient, 4);
  assert.equal(report.runs.length, 4);
  assert.deepEqual(report.runs.map((run) => run.state), [
    "blocked_plan_insufficient",
    "blocked_plan_insufficient",
    "blocked_plan_insufficient",
    "blocked_plan_insufficient",
  ]);

  for (const run of report.runs) {
    assert.deepEqual(run.missing_fields, ["packet_object"]);
    const snapshot = await readJson(path.join(run.run_dir, "run.json"));
    const events = await readJsonLines(path.join(run.run_dir, "events.jsonl"));
    assert.equal(snapshot.state, "blocked_plan_insufficient");
    assert.equal(snapshot.packet.sufficiency_status, "FAIL");
    assert.deepEqual(snapshot.packet.missing_fields, ["packet_object"]);
    assert.match(snapshot.terminal_reason, /Packet insufficient: packet_object/);
    assert.equal(events.at(-1).state_after, "blocked_plan_insufficient");
  }
});

test("atomic JSON writes leave a complete parseable file and no temp sibling on success", async () => {
  const tempDir = await makeTempDir();
  const targetPath = path.join(tempDir, "state", "sample.json");

  await writeJsonAtomic(targetPath, { schema_version: SCHEMA_VERSION, nested: { ok: true } });

  assert.deepEqual(await readJson(targetPath), { schema_version: SCHEMA_VERSION, nested: { ok: true } });
  const siblings = await fs.readdir(path.dirname(targetPath));
  assert.deepEqual(siblings.filter((name) => name.includes(".tmp")), []);
});

test("slice 1 intake records no runner, PR, or remote projection effects", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });

  for (const run of report.runs) {
    const snapshot = await readJson(path.join(run.run_dir, "run.json"));
    const events = await readJsonLines(path.join(run.run_dir, "events.jsonl"));
    assert.notEqual(snapshot.state, "running");
    assert.notEqual(snapshot.state, "pr_ready");
    assert.notEqual(snapshot.state, "ready_for_manual_review");
    assert.equal(snapshot.github.pr, null);
    assert.deepEqual(snapshot.projections, {});
    assert.equal(events.some((event) => String(event.type).includes("projection")), false);
    assert.equal(events.some((event) => String(event.type).includes("execution")), false);
  }
});

test("state machine allows documented transitions and rejects forbidden transitions", async () => {
  assert.equal(validateTransition({ fromState: "queued", toState: "waiting_for_lock" }).ok, true);
  const forbidden = validateTransition({ fromState: "queued", toState: "verification" });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.reason, /not allowed/);
  const terminal = validateTransition({ fromState: "blocked_plan_insufficient", toState: "queued" });
  assert.equal(terminal.ok, false);
  assert.match(terminal.reason, /terminal state/);
});

test("state machine routes verification BLOCKED to blocked_needs_human instead of fix_loop", async () => {
  const blockedSnapshot = {
    state: "verification",
    execution: { current_epoch: 1 },
    gates: {
      verification: {
        status: "BLOCKED",
        current_epoch: 1,
        current_attempt: 1,
      },
    },
  };

  assert.equal(validateTransition({ fromState: "verification", toState: "blocked_needs_human", snapshot: blockedSnapshot }).ok, true);
  const blockedToFixLoop = validateTransition({ fromState: "verification", toState: "fix_loop", snapshot: blockedSnapshot });
  assert.equal(blockedToFixLoop.ok, false);
  assert.match(blockedToFixLoop.reason, /requires a current verification FAIL result/);
});

test("state machine requires a recorded PR projection result before ready_for_manual_review", () => {
  const missingProjection = validateTransition({
    fromState: "pr_ready",
    toState: "ready_for_manual_review",
    snapshot: {
      state: "pr_ready",
      execution: { current_epoch: 1 },
      github: { repo: "MrFlashAccount/example-repo", issue_number: 17, intended_branch: "sergey/feature", base_branch: "develop", pr: null },
      projections: {},
    },
  });
  assert.equal(missingProjection.ok, false);
  assert.match(missingProjection.reason, /recorded PR projection result/i);

  const readyProjection = validateTransition({
    fromState: "pr_ready",
    toState: "ready_for_manual_review",
    snapshot: {
      state: "pr_ready",
      execution: { current_epoch: 1 },
      github: {
        repo: "MrFlashAccount/example-repo",
        issue_number: 17,
        intended_branch: "sergey/feature",
        base_branch: "develop",
        pr: {
          number: 123456,
          url: "local://github-pr/example/pull/123456",
          repo: "MrFlashAccount/example-repo",
          issue_number: 17,
          head_branch: "sergey/feature",
          base_branch: "develop",
          state: "open",
          draft: false,
          title: "Buran handoff for feature",
        },
      },
      projections: {
        github_pr: {
          execution_epoch: 1,
          projection_name: "github_pr",
          projection_target: "github.pr",
          adapter: "local-github-pr-projection",
          mode: "local_fake",
          recorded_from_state: "pr_ready",
          last_result: {
            execution_epoch: 1,
            recorded_from_state: "pr_ready",
            idempotency_key: "run:projection:result",
            intent_idempotency_key: "run:projection:intent",
            status: "projected_local",
            artifact_ref: { path: "artifacts/pr/projection-result-abc123.json", sha256: "a".repeat(64) },
            recorded_at: "2026-05-16T13:57:00.000Z",
            actor: "runner-test",
            sequence: 7,
            github_pr: {
              number: 123456,
              url: "local://github-pr/example/pull/123456",
              repo: "MrFlashAccount/example-repo",
              issue_number: 17,
              head_branch: "sergey/feature",
              base_branch: "develop",
              state: "open",
              draft: false,
              title: "Buran handoff for feature",
            },
          },
        },
      },
    },
  });
  assert.equal(readyProjection.ok, true);

  const failedStatusProjection = validateTransition({
    fromState: "pr_ready",
    toState: "ready_for_manual_review",
    snapshot: {
      state: "pr_ready",
      execution: { current_epoch: 1 },
      github: {
        repo: "MrFlashAccount/example-repo",
        issue_number: 17,
        intended_branch: "sergey/feature",
        base_branch: "develop",
        pr: {
          number: 123456,
          url: "local://github-pr/example/pull/123456",
          repo: "MrFlashAccount/example-repo",
          issue_number: 17,
          head_branch: "sergey/feature",
          base_branch: "develop",
          state: "open",
          draft: false,
          title: "Buran handoff for feature",
        },
      },
      projections: {
        github_pr: {
          execution_epoch: 1,
          projection_name: "github_pr",
          projection_target: "github.pr",
          adapter: "local-github-pr-projection",
          mode: "local_fake",
          recorded_from_state: "pr_ready",
          last_result: {
            execution_epoch: 1,
            recorded_from_state: "pr_ready",
            idempotency_key: "run:projection:result",
            intent_idempotency_key: "run:projection:intent",
            status: "failed_remote_write",
            artifact_ref: { path: "artifacts/pr/projection-result-abc123.json", sha256: "a".repeat(64) },
            recorded_at: "2026-05-16T13:57:00.000Z",
            actor: "runner-test",
            sequence: 7,
            github_pr: {},
          },
        },
      },
    },
  });
  assert.equal(failedStatusProjection.ok, false);
  assert.match(failedStatusProjection.reason, /recorded PR projection result/i);

  const missingUrlProjection = validateTransition({
    fromState: "pr_ready",
    toState: "ready_for_manual_review",
    snapshot: {
      state: "pr_ready",
      execution: { current_epoch: 1 },
      github: {
        repo: "MrFlashAccount/example-repo",
        issue_number: 17,
        intended_branch: "sergey/feature",
        base_branch: "develop",
        pr: {
          number: 123456,
          url: "",
          repo: "MrFlashAccount/example-repo",
          issue_number: 17,
          head_branch: "sergey/feature",
          base_branch: "develop",
          state: "open",
          draft: false,
          title: "Buran handoff for feature",
        },
      },
      projections: {
        github_pr: {
          execution_epoch: 1,
          projection_name: "github_pr",
          projection_target: "github.pr",
          adapter: "local-github-pr-projection",
          mode: "local_fake",
          recorded_from_state: "pr_ready",
          last_result: {
            execution_epoch: 1,
            recorded_from_state: "pr_ready",
            idempotency_key: "run:projection:result",
            intent_idempotency_key: "run:projection:intent",
            status: "projected_local",
            artifact_ref: { path: "artifacts/pr/projection-result-abc123.json", sha256: "a".repeat(64) },
            recorded_at: "2026-05-16T13:57:00.000Z",
            actor: "runner-test",
            sequence: 7,
            github_pr: {
              number: 123456,
              url: "",
              repo: "MrFlashAccount/example-repo",
              issue_number: 17,
              head_branch: "sergey/feature",
              base_branch: "develop",
              state: "open",
              draft: false,
              title: "Buran handoff for feature",
            },
          },
        },
      },
    },
  });
  assert.equal(missingUrlProjection.ok, false);
  assert.match(missingUrlProjection.reason, /recorded PR projection result/i);
});

test("run snapshot validation rejects corrupt successful projection state", () => {
  const corruptSnapshot = projectionReadySnapshot();
  corruptSnapshot.github.pr = {};
  corruptSnapshot.projections.github_pr.last_result.github_pr = {};

  const decision = validateRunSnapshot(corruptSnapshot, { expectedRunId: "run_projection_ready" });
  assert.equal(decision.ok, false);
  assert.match(decision.error, /github\.pr\.url|successful projections\.github_pr\.last_result requires github\.pr/i);
});

test("projection adapter sanitizes durable projection artifacts", () => {
  const projection = buildLocalPrProjection({
    run_id: "run_projection_sanitized",
    task_id: `task ${GITHUB_PAT_SECRET} /Users/sergey/private/notes.md`,
    state: "pr_ready",
    execution: { current_epoch: 1 },
    gates: {
      verification: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [] },
      internal_review: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [] },
    },
    github: {
      repo: `MrFlashAccount/${GHP_SECRET}`,
      issue_number: 17,
      intended_branch: `feature/${GLPAT_SECRET}/Users/sergey/private`,
      base_branch: `develop/${GITHUB_PAT_SECRET}`,
    },
    projections: {},
  }, {
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
    actor: `runner ${GHP_SECRET}`,
  });

  const durableText = `${projection.intentArtifactContent}\n${projection.resultArtifactContent}`;
  assertPublicOutputRedactsSyntheticSecrets(durableText);
  assert.doesNotMatch(durableText, /\/Users\/sergey\//);
  assert.match(durableText, /<absolute_path>|\[REDACTED_SECRET\]/);
});

test("state machine routes internal_review BLOCKED to blocked_needs_human instead of fix_loop", async () => {
  const blockedSnapshot = {
    state: "internal_review",
    execution: { current_epoch: 1 },
    gates: {
      verification: {
        status: "PASS",
        current_epoch: 1,
        current_attempt: 1,
      },
      internal_review: {
        status: "BLOCKED",
        current_epoch: 1,
        current_attempt: 1,
      },
    },
  };

  assert.equal(validateTransition({ fromState: "internal_review", toState: "blocked_needs_human", snapshot: blockedSnapshot }).ok, true);
  const blockedToFixLoop = validateTransition({ fromState: "internal_review", toState: "fix_loop", snapshot: blockedSnapshot });
  assert.equal(blockedToFixLoop.ok, false);
  assert.match(blockedToFixLoop.reason, /requires a current internal_review FAIL result/);
});

test("registry transitions persist run snapshot and event journal consistently", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");

  const committed = await transitionRun(registryRoot, queuedRun.run_id, {
    toState: "waiting_for_lock",
    actor: "test-lock-adapter",
    evidence: { reason: "accepted into manual batch" },
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  assert.equal(committed.run.state, "waiting_for_lock");
  const snapshot = await readJson(path.join(queuedRun.run_dir, "run.json"));
  const events = await readJsonLines(path.join(queuedRun.run_dir, "events.jsonl"));
  assert.equal(snapshot.state, "waiting_for_lock");
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events.at(-1).state_before, "queued");
  assert.equal(events.at(-1).state_after, "waiting_for_lock");
});

test("registry transition engine blocks terminal state transitions", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const blockedRun = report.runs.find((run) => run.task_id === "weak-task-18");

  await assert.rejects(
    () => transitionRun(registryRoot, blockedRun.run_id, { toState: "queued", actor: "test" }),
    /terminal state blocked_plan_insufficient/,
  );
});

test("recovery replays events and rebuilds active-run indexes", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  await fs.rm(path.join(registryRoot, "indexes"), { recursive: true, force: true });

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.equal(recovery.summary.inspected_runs, 2);
  assert.equal(recovery.summary.valid_runs, 2);
  assert.equal(recovery.summary.quarantined_runs, 0);
  assert.equal(recovery.runs.find((run) => run.run_id === queuedRun.run_id).state, "queued");
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.deepEqual(activeRuns.runs.map((run) => run.run_id), [queuedRun.run_id]);
});

test("recovery quarantines incomplete run snapshots instead of indexing them", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const runId = "run_minimal_incomplete";
  const runDir = path.join(registryRoot, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  await writeJsonAtomic(path.join(runDir, "run.json"), {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    state: "queued",
  });
  await fs.writeFile(path.join(runDir, "events.jsonl"), [
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      sequence: 1,
      timestamp: "2026-05-16T14:00:00.000Z",
      type: "transition",
      state_before: null,
      state_after: "packet_received",
      actor: "test",
      evidence: {},
      idempotency_key: `${runId}:packet_received:1`,
    }),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      sequence: 2,
      timestamp: "2026-05-16T14:00:01.000Z",
      type: "transition",
      state_before: "packet_received",
      state_after: "queued",
      actor: "test",
      evidence: {},
      idempotency_key: `${runId}:queued:2`,
    }),
    "",
  ].join("\n"), "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:02.000Z") });

  assert.equal(recovery.summary.valid_runs, 0);
  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "invalid_run_snapshot");
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.deepEqual(activeRuns.runs, []);
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.match(quarantineReport.details.error, /missing required field: task_id/);
});

test("recovery quarantines events missing required replay fields", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  const eventsPath = path.join(queuedRun.run_dir, "events.jsonl");
  const events = await readJsonLines(eventsPath);
  delete events[1].timestamp;
  delete events[1].actor;
  delete events[1].evidence;
  await fs.writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].run_id, queuedRun.run_id);
  assert.equal(recovery.quarantined[0].reason, "invalid_event_replay");
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.equal(activeRuns.runs.some((run) => run.run_id === queuedRun.run_id), false);
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.match(quarantineReport.details.error, /timestamp is missing or invalid/);
});

test("recovery quarantines corrupt run.json to an inspectable human-needed path", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  await fs.writeFile(path.join(queuedRun.run_dir, "run.json"), "{not json", "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "corrupt_run_json");
  assert.equal(await pathExists(path.join(queuedRun.run_dir, "run.json")), false);
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.equal(quarantineReport.human_needed, true);
  assert.equal(quarantineReport.run_id, queuedRun.run_id);
});

test("recovery quarantines malformed or truncated events.jsonl", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  await fs.appendFile(path.join(queuedRun.run_dir, "events.jsonl"), "{truncated", "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "malformed_events_jsonl");
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.equal(quarantineReport.details.malformed[0].trailing, true);
});

test("recovery quarantines artifact integrity failures", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  const snapshot = await readJson(path.join(queuedRun.run_dir, "run.json"));
  await fs.writeFile(path.join(queuedRun.run_dir, snapshot.artifacts.packet.path), "tampered artifact", "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:00.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "artifact_integrity_failure");
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.equal(quarantineReport.details.findings[0].type, "artifact_hash_mismatch");
});

test("recovery CLI produces a local report without packets or external effects", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  await intakePacketListFile(fixturePath, { registryRoot });

  const result = await runBuranCli(["recover", "--registry", registryRoot, "--json"]);

  assert.equal(result.ok, true);
  const report = JSON.parse(result.text);
  assert.equal(report.mode, "recovery");
  assert.equal(report.external_side_effects, false);
  assert.equal(report.summary.inspected_runs, 2);
  assert.equal(await pathExists(path.join(registryRoot, "indexes", "recovery-report.json")), true);
});

test("lease acquisition reserves workspace and lock surfaces without creating a checkout", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");

  const acquired = await acquireWorkspaceLease(registryRoot, queuedRun.run_id, {
    workspaceId: "ws-a",
    ttlMs: 60_000,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  assert.equal(acquired.status, "acquired");
  assert.equal(acquired.run.state, "running");
  assert.equal(acquired.run.workspace.id, "ws-a");
  assert.equal(acquired.run.workspace.lease_status, "acquired");
  assert.equal(acquired.run.locks.lease_status, "acquired");
  assert.equal(acquired.run.workspace.expires_at, "2026-05-16T13:54:00.000Z");
  assert.equal(await pathExists(acquired.lease.workspace_path), false);
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 6);

  const events = await readJsonLines(path.join(queuedRun.run_dir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "lock.lease_acquired"));
  assert.deepEqual(events.filter((event) => event.type === "transition").map((event) => event.state_after), ["packet_received", "queued", "waiting_for_lock", "running"]);
  const leaseIndex = await readJson(path.join(registryRoot, "indexes", "workspace-leases.json"));
  assert.equal(leaseIndex.leases.length, 1);
  assert.equal(leaseIndex.leases[0].workspace_id, "ws-a");
});

test("lease acquisition blocks conflicting active issue/branch/surface runs and does not keep partial locks", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [
    goodPacket({ taskId: "task-a", issue: 21, branch: "sergey/task-a", conflictSurface: "src/same-area" }),
    goodPacket({ taskId: "task-b", issue: 21, branch: "sergey/task-a", conflictSurface: "src/same-area" }),
  ]);
  const report = await intakePacketListFile(packetPath, { registryRoot });

  const first = await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, { workspaceId: "ws-a" });
  const second = await acquireWorkspaceLease(registryRoot, report.runs[1].run_id, { workspaceId: "ws-b" });

  assert.equal(first.status, "acquired");
  assert.equal(second.status, "blocked_lock_conflict");
  assert.equal(second.run.state, "blocked_lock_conflict");
  assert.ok(second.conflicts.some((conflict) => conflict.surface === "issue"));
  assert.match(second.run.terminal_reason, /Lock conflict/);
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 6);
  const activeRuns = await readJson(path.join(registryRoot, "indexes", "active-runs.json"));
  assert.equal(activeRuns.runs.some((run) => run.run_id === report.runs[1].run_id), false);
});

test("lease conflict reports dedupe exact active snapshot and lease-record overlaps", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [
    goodPacket({ taskId: "dedupe-owner", issue: 71, branch: "sergey/dedupe", conflictSurface: "src/dedupe-area" }),
    goodPacket({ taskId: "dedupe-contender", issue: 71, branch: "sergey/dedupe", conflictSurface: "src/dedupe-area" }),
  ]);
  const report = await intakePacketListFile(packetPath, { registryRoot });
  await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, { workspaceId: "ws-dedupe-owner" });

  const contender = await acquireWorkspaceLease(registryRoot, report.runs[1].run_id, { workspaceId: "ws-dedupe-contender" });

  assert.equal(contender.status, "blocked_lock_conflict");
  assert.deepEqual(contender.conflicts.map((conflict) => conflict.surface), ["issue", "branch", "conflict_surface"]);
  const conflictSurfaces = contender.conflicts.map((conflict) => `${conflict.surface}:${conflict.key}:${conflict.owner_run_id}`);
  assert.equal(new Set(conflictSurfaces).size, conflictSurfaces.length);
  assert.equal(contender.conflicts.every((conflict) => conflict.owner_run_id === report.runs[0].run_id), true);
});

test("lease acquisition blocks the same physical workspace path across different workspace ids and repos", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const sharedWorkspacePath = path.join(tempDir, "shared-workspace");
  const packetPath = await writePacketList(tempDir, [
    goodPacket({ taskId: "path-owner", issue: 51, branch: "sergey/path-owner", conflictSurface: "src/path-owner", repo: "MrFlashAccount/repo-a" }),
    goodPacket({ taskId: "path-contender", issue: 52, branch: "sergey/path-contender", conflictSurface: "src/path-contender", repo: "MrFlashAccount/repo-b" }),
  ]);
  const report = await intakePacketListFile(packetPath, { registryRoot });

  const owner = await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, {
    workspaceId: "ws-path-a",
    workspacePath: sharedWorkspacePath,
  });
  const contender = await acquireWorkspaceLease(registryRoot, report.runs[1].run_id, {
    workspaceId: "ws-path-b",
    workspacePath: sharedWorkspacePath,
  });

  assert.equal(owner.status, "acquired");
  assert.equal(contender.status, "blocked_lock_conflict");
  assert.ok(contender.conflicts.some((conflict) => conflict.surface === "workspace_path"));
});

test("lease manager supports four non-conflicting workspaces for the same repo", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [0, 1, 2, 3].map((index) => goodPacket({
    taskId: `parallel-${index}`,
    issue: 100 + index,
    branch: `sergey/parallel-${index}`,
    conflictSurface: `src/area-${index}`,
  })));
  const report = await intakePacketListFile(packetPath, { registryRoot });

  const results = [];
  for (let index = 0; index < report.runs.length; index += 1) {
    results.push(await acquireWorkspaceLease(registryRoot, report.runs[index].run_id, {
      workspaceId: `ws-${index}`,
      workspacePath: path.join(tempDir, `workspace-${index}`),
    }));
  }

  assert.deepEqual(results.map((result) => result.status), ["acquired", "acquired", "acquired", "acquired"]);
  assert.deepEqual(results.map((result) => result.run.workspace.id), ["ws-0", "ws-1", "ws-2", "ws-3"]);
  const leaseIndex = await readJson(path.join(registryRoot, "indexes", "workspace-leases.json"));
  assert.equal(leaseIndex.leases.length, 4);
  assert.deepEqual(leaseIndex.leases.map((lease) => lease.workspace_id), ["ws-0", "ws-1", "ws-2", "ws-3"]);
});

test("lease conflicts are still detected from active run snapshots when lease files are missing", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [
    goodPacket({ taskId: "snapshot-owner", issue: 41, branch: "sergey/snapshot-owner", conflictSurface: "src/snapshot-area" }),
    goodPacket({ taskId: "snapshot-contender", issue: 41, branch: "sergey/snapshot-owner", conflictSurface: "src/snapshot-area" }),
  ]);
  const report = await intakePacketListFile(packetPath, { registryRoot });
  await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, { workspaceId: "ws-owner" });
  await fs.rm(path.join(registryRoot, "leases"), { recursive: true, force: true });

  const contender = await acquireWorkspaceLease(registryRoot, report.runs[1].run_id, { workspaceId: "ws-contender" });

  assert.equal(contender.status, "blocked_lock_conflict");
  assert.ok(contender.conflicts.some((conflict) => conflict.reason === "active_run_lock_overlap" && conflict.owner_run_id === report.runs[0].run_id));
});

test("partial lease acquisition rolls back already-created local lock records on a concurrent write conflict", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [goodPacket({ taskId: "race-task", issue: 31, branch: "sergey/race-task", conflictSurface: "src/race-area" })]);
  const report = await intakePacketListFile(packetPath, { registryRoot });
  let injected = false;

  const result = await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, {
    workspaceId: "ws-race",
    beforeWriteLeaseRecord: async ({ index, lock }) => {
      if (index !== 2 || injected) return;
      injected = true;
      const recordPath = getLeaseRecordPath(registryRoot, lock.key);
      await fs.mkdir(path.dirname(recordPath), { recursive: true });
      await fs.writeFile(recordPath, `${JSON.stringify({
        schema_version: SCHEMA_VERSION,
        lease_id: "lease_interloper",
        run_id: "run_interloper",
        status: "acquired",
        surface: lock.surface,
        key: lock.key,
        value: lock.value,
        workspace_id: "ws-interloper",
        workspace_path: path.join(tempDir, "workspace-interloper"),
        repo: "MrFlashAccount/example-repo",
        issue_number: 31,
        branch: "sergey/race-task",
        conflict_surface: ["src/race-area"],
        acquired_at: "2026-05-16T13:53:00.000Z",
        expires_at: "2026-05-16T14:53:00.000Z",
        ttl_ms: 3_600_000,
      }, null, 2)}\n`, "utf8");
    },
  });

  assert.equal(result.status, "blocked_lock_conflict");
  assert.equal(result.rolled_back_records, 2);
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 1);
  const snapshot = await readJson(path.join(report.runs[0].run_dir, "run.json"));
  assert.equal(snapshot.state, "blocked_lock_conflict");
  assert.equal(snapshot.workspace.lease_status, "not_requested");
});

test("recovery reclaims stale TTL leases, removes lock records, and keeps ownership explicit", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot, clock: () => new Date("2026-05-16T13:52:00.000Z") });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  await acquireWorkspaceLease(registryRoot, queuedRun.run_id, {
    workspaceId: "ws-stale",
    ttlMs: 1_000,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T13:53:02.000Z") });

  assert.ok(recovery.findings.some((finding) => finding.type === "stale_lease_reclaimed" && finding.run_id === queuedRun.run_id));
  assert.equal(recovery.summary.workspace_leases, 0);
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 0);
  const snapshot = await readJson(path.join(queuedRun.run_dir, "run.json"));
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.workspace.lease_status, "stale_recovered");
  assert.equal(snapshot.locks.lease_status, "stale_recovered");
  const events = await readJsonLines(path.join(queuedRun.run_dir, "events.jsonl"));
  assert.equal(events.at(-1).type, "recovery.lease_stale_reclaimed");
});

test("terminal runs immediately release active leases and do not block a later same-surface run", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [
    goodPacket({ taskId: "terminal-owner", issue: 61, branch: "sergey/terminal-same", conflictSurface: "src/terminal-same" }),
    goodPacket({ taskId: "terminal-contender", issue: 61, branch: "sergey/terminal-same", conflictSurface: "src/terminal-same" }),
  ]);
  const report = await intakePacketListFile(packetPath, { registryRoot });
  await acquireWorkspaceLease(registryRoot, report.runs[0].run_id, { workspaceId: "ws-terminal-a" });

  const terminal = await transitionRun(registryRoot, report.runs[0].run_id, {
    toState: "failed_execution",
    actor: "test-runner",
    evidence: { terminal_reason: "test terminal release" },
  });
  assert.equal(terminal.run.state, "failed_execution");
  assert.equal(terminal.run.workspace.lease_status, "released");
  assert.equal(terminal.run.locks.lease_status, "released");
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 0);

  const contender = await acquireWorkspaceLease(registryRoot, report.runs[1].run_id, { workspaceId: "ws-terminal-b" });
  assert.equal(contender.status, "acquired");
  assert.equal(contender.run.state, "running");

  const recovery = await recoverRegistry(registryRoot);
  assert.equal(recovery.summary.active_runs, 1);
  assert.equal(recovery.summary.workspace_leases, 1);
  assert.equal((await listLeaseRecordFiles(registryRoot)).length, 6);
});

test("recovery quarantines unknown non-transition event types instead of accepting timestamped events", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");
  await fs.appendFile(path.join(queuedRun.run_dir, "events.jsonl"), `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    run_id: queuedRun.run_id,
    sequence: 3,
    timestamp: "2026-05-16T14:00:00.000Z",
    type: "mystery.local_event",
    actor: "test",
    evidence: { looks_plausible: true },
    idempotency_key: `${queuedRun.run_id}:mystery:3`,
  })}\n`, "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:00:01.000Z") });

  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "invalid_event_replay");
  const quarantineReport = await readJson(recovery.quarantined[0].report_path);
  assert.match(quarantineReport.details.error, /unknown event type: mystery\.local_event/);
});

test("lease CLI smoke acquires a local lease and recovery reports no external side effects", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const report = await intakePacketListFile(fixturePath, { registryRoot });
  const queuedRun = report.runs.find((run) => run.task_id === "good-task-17");

  const leaseResult = await runBuranCli(["lease", "acquire", "--run", queuedRun.run_id, "--workspace-id", "ws-cli", "--registry", registryRoot, "--json"]);
  assert.equal(leaseResult.ok, true);
  const leaseReport = JSON.parse(leaseResult.text);
  assert.equal(leaseReport.mode, "lease_acquire");
  assert.equal(leaseReport.status, "acquired");
  assert.equal(leaseReport.external_side_effects, false);

  const recoverResult = await runBuranCli(["recover", "--registry", registryRoot, "--json"]);
  const recovery = JSON.parse(recoverResult.text);
  assert.equal(recovery.mode, "recovery");
  assert.equal(recovery.external_side_effects, false);
  assert.equal(recovery.summary.workspace_leases, 1);
});

test("CLI observability writes structured local logs, diagnostic report, and trace correlation", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const runtime = normalizeObservabilityConfig({}, { workspaceDir: tempDir });

  const result = await runBuranCli(["intake", "--packets", fixturePath, "--registry", registryRoot, "--json"], { workspaceDir: tempDir });

  assert.equal(result.ok, true);
  const report = JSON.parse(result.text);
  assert.match(report.observability.trace_id, /^trace_\d{14}_[a-f0-9]{12}$/);
  assert.equal(report.observability.log_path, "<observability>/logs/operational.jsonl");
  assert.equal(report.observability.diagnostic_report_path, `<observability>/diagnostics/${report.observability.trace_id}.json`);

  const logEvents = await readJsonLines(runtime.logPath);
  const traceEvents = logEvents.filter((event) => event.trace_id === report.observability.trace_id);
  assert.ok(traceEvents.length >= 4);
  assert.ok(traceEvents.every((event) => event.schema_version === "observability.v1"));
  assert.ok(traceEvents.every((event) => event.component === "cli"));
  assert.ok(traceEvents.every((event) => typeof event.timestamp === "string" && event.timestamp.length > 0));
  assert.ok(traceEvents.some((event) => event.event === "cli.invocation.started"));
  const completed = traceEvents.find((event) => event.event === "intake.completed");
  assert.ok(completed);
  assert.equal(completed.outcome, "success");
  assert.equal(completed.batch_id, report.batch.batch_id);
  assert.equal(typeof completed.duration_ms, "number");

  const diagnostic = await readJson(path.join(runtime.diagnosticsDir, `${report.observability.trace_id}.json`));
  assert.equal(diagnostic.schema_version, "observability.v1");
  assert.equal(diagnostic.trace_id, report.observability.trace_id);
  assert.equal(diagnostic.outcome, "success");
  assert.equal(diagnostic.external_telemetry, false);
  assert.equal(diagnostic.report_summary.batch_id, report.batch.batch_id);
  assert.equal(diagnostic.paths.log_path, "<observability>/logs/operational.jsonl");
  assert.equal(diagnostic.paths.diagnostic_report_path, `<observability>/diagnostics/${report.observability.trace_id}.json`);
});

test("observability CLI output and diagnostics do not leak private or synthetic home paths", async () => {
  const tempDir = await makeTempDir();
  const syntheticHome = path.join(tempDir, "synthetic-home");
  const workspaceDir = path.join(syntheticHome, "workspace");
  const stateDir = path.join(syntheticHome, "state");
  const registryRoot = path.join(syntheticHome, "registry");
  const runtime = normalizeObservabilityConfig({}, { workspaceDir, stateDir });

  const result = await runBuranCli(["intake", "--packets", fixturePath, "--registry", registryRoot, "--json"], { workspaceDir, stateDir });

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(result.text, /\/Users\/sergeygarin/);

  const report = JSON.parse(result.text);
  assert.equal(report.registry.root, "<registry>");
  assert.equal(report.observability.log_path, "<observability>/logs/operational.jsonl");
  assert.equal(report.observability.diagnostic_report_path, `<observability>/diagnostics/${report.observability.trace_id}.json`);

  const diagnosticPath = path.join(runtime.diagnosticsDir, `${report.observability.trace_id}.json`);
  const diagnosticText = await fs.readFile(diagnosticPath, "utf8");
  assert.doesNotMatch(diagnosticText, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(diagnosticText, /\/Users\/sergeygarin/);
  const diagnostic = JSON.parse(diagnosticText);
  assert.equal(diagnostic.paths.log_path, "<observability>/logs/operational.jsonl");
  assert.equal(diagnostic.paths.diagnostic_report_path, `<observability>/diagnostics/${report.observability.trace_id}.json`);
});



test("path output sanitizer redacts unmapped absolute paths and preserves safe relative text", () => {
  assert.equal(sanitizePathForOutput("/tmp/synthetic-private-manual/path.js", []), "<absolute_path>/path.js");
  assert.equal(sanitizePathForOutput("/Users/sergeygarin/private/subpath", []), "<absolute_path>");
  assert.equal(sanitizePathForOutput("C:\\Users\\Sergey\\secret\\file.txt", []), "<absolute_path>/file.txt");
  assert.equal(sanitizePathForOutput("docs/a/b", []), "docs/a/b");
  assert.equal(sanitizePathForOutput("relative text with docs/a/b", []), "relative text with docs/a/b");
  assert.equal(sanitizePathForOutput("https://example.com/tmp/safe/path.js", []), "https://example.com/tmp/safe/path.js");
});

test("public report sanitizer redacts arbitrary absolute paths while preserving URLs", () => {
  const sanitized = sanitizePublicReportForOutput({
    conflict_surface: [
      `/tmp/synthetic-private-${GLPAT_SECRET}/path.js`,
      `/var/folders/private-${GITHUB_PAT_SECRET}/cache/output.log`,
      "/home/sergey/private/project/src/index.ts",
      "/Users/sergeygarin/private/subpath",
      "/workspace/repo/src/public.js",
      "https://example.com/tmp/safe/path.js",
      "docs/a/b",
    ],
    branch: `sergey/${GHP_SECRET}`,
    nested: { message: `failed at /tmp/synthetic-private-${GHP_SECRET}/nested/file.ts` },
  });
  const text = JSON.stringify(sanitized);

  assert.doesNotMatch(text, /\/tmp\/synthetic-private/);
  assert.doesNotMatch(text, /\/var\/folders/);
  assert.doesNotMatch(text, /\/home\/sergey/);
  assert.doesNotMatch(text, /\/Users\/sergeygarin/);
  assert.doesNotMatch(text, /private\/subpath/);
  assert.doesNotMatch(text, /subpath/);
  assertPublicOutputRedactsSyntheticSecrets(text);
  assert.match(text, /<absolute_path>\/path\.js/);
  assert.match(text, /<absolute_path>\/output\.log/);
  assert.match(text, /<absolute_path>\/index\.ts/);
  assert.match(text, /<absolute_path>\/public\.js/);
  assert.match(text, /<absolute_path>\/file\.ts/);
  assert.equal(sanitized.conflict_surface[5], "https://example.com/tmp/safe/path.js");
  assert.equal(sanitized.conflict_surface[6], "docs/a/b");
});

test("validate public JSON report redacts secrets across packet ids, branches, and conflict surfaces", async () => {
  const tempDir = await makeTempDir();
  const packetPath = await writePacketList(tempDir, [goodPacket({
    taskId: `task-${GITHUB_PAT_SECRET}`,
    issue: 81,
    branch: `sergey/secret-${GHP_SECRET}`,
    conflictSurface: ["src/safe-area", `src/conflict-${GITHUB_PAT_SECRET}`, `src/gitlab-${GLPAT_SECRET}`, `/tmp/synthetic-private-${GLPAT_SECRET}/path.js`],
  })]);

  const result = await runBuranCli(["validate", "--packets", packetPath, "--json"], { workspaceDir: tempDir });

  assert.equal(result.ok, true);
  assertPublicOutputRedactsSyntheticSecrets(result.text);
  const report = JSON.parse(result.text);
  assert.equal(report.packets[0].task_id, "task-[REDACTED_SECRET]");
  assert.match(report.packets[0].run_id, /\[REDACTED_SECRET\]/);
  assert.equal(report.packets[0].github.intended_branch, "sergey/secret-[REDACTED_SECRET]");
  assert.deepEqual(report.packets[0].conflict_surface, ["src/safe-area", "src/conflict-[REDACTED_SECRET]", "src/gitlab-[REDACTED_SECRET]", "<absolute_path>/path.js"]);
  assert.doesNotMatch(result.text, /\/tmp\/synthetic-private/);
});

test("validate public text report redacts secret-like substrings in task ids", async () => {
  const tempDir = await makeTempDir();
  const packetPath = await writePacketList(tempDir, [goodPacket({
    taskId: `task-${GLPAT_SECRET}`,
    issue: 82,
    branch: "sergey/public-text-redaction",
    conflictSurface: "src/public-text-redaction",
  })]);

  const result = await runBuranCli(["validate", "--packets", packetPath], { workspaceDir: tempDir });

  assert.equal(result.ok, true);
  assertPublicOutputRedactsSyntheticSecrets(result.text);
  assert.match(result.text, /task-\[REDACTED_SECRET\]: PASS/);
});

test("intake public JSON and text reports redact secrets without hiding packet summaries", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const packetPath = await writePacketList(tempDir, [goodPacket({
    taskId: `intake-${GITHUB_PAT_SECRET}`,
    issue: 83,
    branch: `sergey/intake-${GHP_SECRET}`,
    conflictSurface: [`src/intake-${GITHUB_PAT_SECRET}`, `src/intake-gitlab-${GLPAT_SECRET}`, `/tmp/synthetic-private-${GLPAT_SECRET}/path.js`],
  })]);

  const jsonResult = await runBuranCli(["intake", "--packets", packetPath, "--registry", registryRoot, "--json"], { workspaceDir: tempDir });
  const textResult = await runBuranCli(["intake", "--packets", packetPath, "--registry", path.join(tempDir, "registry-text")], { workspaceDir: tempDir });

  assert.equal(jsonResult.ok, true);
  assert.equal(textResult.ok, true);
  assertPublicOutputRedactsSyntheticSecrets(jsonResult.text);
  assertPublicOutputRedactsSyntheticSecrets(textResult.text);
  assert.match(textResult.text, /intake-\[REDACTED_SECRET\]: PASS/);
  const report = JSON.parse(jsonResult.text);
  assert.equal(report.packets.length, 1);
  assert.equal(report.runs.length, 1);
  assert.equal(report.packets[0].github.intended_branch, "sergey/intake-[REDACTED_SECRET]");
  assert.deepEqual(report.packets[0].conflict_surface, ["src/intake-[REDACTED_SECRET]", "src/intake-gitlab-[REDACTED_SECRET]", "<absolute_path>/path.js"]);
  assert.doesNotMatch(jsonResult.text, /\/tmp\/synthetic-private/);
  assert.doesNotMatch(textResult.text, /\/tmp\/synthetic-private/);
  assert.match(report.runs[0].task_id, /\[REDACTED_SECRET\]/);
});

test("operational logs, diagnostics, and api.logger mirror redact GitLab token-like derived fields", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const runtime = normalizeObservabilityConfig({}, { workspaceDir: tempDir });
  const mirroredLogs = [];
  const apiLogger = {
    debug(entry) { mirroredLogs.push(entry); },
    info(entry) { mirroredLogs.push(entry); },
    warn(entry) { mirroredLogs.push(entry); },
    error(entry) { mirroredLogs.push(entry); },
  };
  const packetPath = await writePacketList(tempDir, [goodPacket({
    taskId: `gitlab-${GLPAT_SECRET}`,
    issue: 84,
    branch: `sergey/gitlab-${GLPAT_SECRET}`,
    conflictSurface: [`src/gitlab-${GLPAT_SECRET}`],
  })]);

  const result = await runBuranCli(["intake", "--packets", packetPath, "--registry", registryRoot, "--json"], { workspaceDir: tempDir, apiLogger });

  assert.equal(result.ok, true);
  const logText = await fs.readFile(runtime.logPath, "utf8");
  const mirroredText = JSON.stringify(mirroredLogs);
  assert.doesNotMatch(logText, new RegExp(escapeRegExp(GLPAT_SECRET)));
  assert.match(logText, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(mirroredText, new RegExp(escapeRegExp(GLPAT_SECRET)));
  assert.match(mirroredText, /\[REDACTED_SECRET\]/);

  const publicReport = JSON.parse(result.text);
  const diagnosticText = await fs.readFile(path.join(runtime.diagnosticsDir, `${publicReport.observability.trace_id}.json`), "utf8");
  assert.doesNotMatch(diagnosticText, new RegExp(escapeRegExp(GLPAT_SECRET)));
  assert.match(diagnosticText, /\[REDACTED_SECRET\]/);
});

test("observability failure path sanitizes missing packet paths across public surfaces", async () => {
  const tempDir = await makeTempDir();
  const syntheticHome = path.join(tempDir, "synthetic-home");
  const workspaceDir = path.join(syntheticHome, "workspace");
  const stateDir = path.join(syntheticHome, "state");
  const missingPacketPath = path.join(syntheticHome, "private", "missing-packets.json");
  const runtime = normalizeObservabilityConfig({}, { workspaceDir, stateDir });
  const mirroredLogs = [];
  const apiLogger = {
    debug(entry) { mirroredLogs.push(entry); },
    info(entry) { mirroredLogs.push(entry); },
    warn(entry) { mirroredLogs.push(entry); },
    error(entry) { mirroredLogs.push(entry); },
  };
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.dirname(missingPacketPath), { recursive: true });

  let publicMessage = "";
  await assert.rejects(
    () => runBuranCli(["validate", "--packets", missingPacketPath, "--json"], { workspaceDir, stateDir, apiLogger }),
    (error) => {
      publicMessage = error.publicMessage;
      return error.code === "ENOENT";
    },
  );

  assert.match(publicMessage, /<packet_list>/);
  assert.doesNotMatch(publicMessage, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(publicMessage, new RegExp(escapeRegExp(missingPacketPath)));
  assert.doesNotMatch(publicMessage, /\/Users\/sergeygarin/);

  const logText = await fs.readFile(runtime.logPath, "utf8");
  assert.doesNotMatch(logText, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(logText, new RegExp(escapeRegExp(missingPacketPath)));
  assert.doesNotMatch(logText, /\/Users\/sergeygarin/);
  const failed = logText.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "cli.invocation.failed");
  assert.ok(failed);
  assert.equal(failed.error_kind, "not_found");
  assert.match(failed.context.error.message, /<packet_list>/);

  const mirroredText = JSON.stringify(mirroredLogs);
  assert.doesNotMatch(mirroredText, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(mirroredText, new RegExp(escapeRegExp(missingPacketPath)));
  assert.doesNotMatch(mirroredText, /\/Users\/sergeygarin/);
  assert.match(mirroredText, /<packet_list>/);

  const diagnosticFiles = (await fs.readdir(runtime.diagnosticsDir)).filter((name) => name.endsWith(".json"));
  assert.equal(diagnosticFiles.length, 1);
  const diagnosticText = await fs.readFile(path.join(runtime.diagnosticsDir, diagnosticFiles[0]), "utf8");
  assert.doesNotMatch(diagnosticText, new RegExp(escapeRegExp(syntheticHome)));
  assert.doesNotMatch(diagnosticText, new RegExp(escapeRegExp(missingPacketPath)));
  assert.doesNotMatch(diagnosticText, /\/Users\/sergeygarin/);
  const diagnostic = JSON.parse(diagnosticText);
  assert.equal(diagnostic.error_kind, "not_found");
  assert.match(diagnostic.reason, /<packet_list>/);
  assert.match(diagnostic.error.message, /<packet_list>/);
});

test("public CLI errors sanitize /Users-style paths and secrets on failure", async () => {
  const tempDir = await makeTempDir();
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const userHomeMissingPath = "/Users/sergeygarin/private/token=github_pat_1234567890abcdefghijklmnop/missing-packets.json";

  let publicMessage = "";
  await assert.rejects(
    () => runBuranCli(["validate", "--packets", userHomeMissingPath, "--json"], { workspaceDir }),
    (error) => {
      publicMessage = error.publicMessage;
      return error.code === "ENOENT";
    },
  );

  assert.doesNotMatch(publicMessage, /\/Users\/sergeygarin/);
  assert.doesNotMatch(publicMessage, /github_pat_1234567890abcdefghijklmnop/);
  assert.match(publicMessage, /<packet_list>/);
});

test("observability redacts secrets, raw packets, user docs, and private home paths", async () => {
  const sanitized = sanitizeForObservability({
    token: "github_pat_1234567890abcdefghijklmnop",
    authorization: "Bearer ghp_1234567890abcdefghijklmnop",
    branch: "sergey/glpat-1234567890abcdefghijklmnop",
    packets: [{ task_id: "should-not-leak", body: "full user document" }],
    raw: "raw packet payload",
    message: "failed at /Users/sergeygarin/private/project with sk-1234567890abcdef",
  });
  const text = JSON.stringify(sanitized);

  assert.equal(sanitized.token, "[REDACTED_SECRET]");
  assert.equal(sanitized.authorization, "[REDACTED_SECRET]");
  assert.equal(sanitized.packets, "[REDACTED_PACKET_DATA]");
  assert.equal(sanitized.raw, "[REDACTED_RAW_CONTENT]");
  assert.doesNotMatch(text, /github_pat_1234567890abcdefghijklmnop/);
  assert.doesNotMatch(text, /ghp_1234567890abcdefghijklmnop/);
  assert.doesNotMatch(text, /glpat-1234567890abcdefghijklmnop/);
  assert.doesNotMatch(text, /sk-1234567890abcdef/);
  assert.doesNotMatch(text, /\/Users\/sergeygarin/);
});

test("observability logs failed CLI errors with bounded error_kind and no raw packet secret leakage", async () => {
  const tempDir = await makeTempDir();
  const runtime = normalizeObservabilityConfig({}, { workspaceDir: tempDir });
  const badPacketPath = path.join(tempDir, "bad-packets.json");
  await fs.writeFile(badPacketPath, "{ glpat-1234567890abcdefghijklmnop", "utf8");

  await assert.rejects(
    () => runBuranCli(["validate", "--packets", badPacketPath, "--json"], { workspaceDir: tempDir }),
    SyntaxError,
  );

  const logText = await fs.readFile(runtime.logPath, "utf8");
  assert.doesNotMatch(logText, /glpat-1234567890abcdefghijklmnop/);
  assert.doesNotMatch(logText, new RegExp(badPacketPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const events = logText.trim().split("\n").map((line) => JSON.parse(line));
  const failed = events.find((event) => event.event === "cli.invocation.failed");
  assert.ok(failed);
  assert.equal(failed.outcome, "error");
  assert.equal(failed.error_kind, "json_parse");

  const diagnosticFiles = (await fs.readdir(runtime.diagnosticsDir)).filter((name) => name.endsWith(".json"));
  assert.equal(diagnosticFiles.length, 1);
  const diagnosticText = await fs.readFile(path.join(runtime.diagnosticsDir, diagnosticFiles[0]), "utf8");
  assert.doesNotMatch(diagnosticText, /glpat-1234567890abcdefghijklmnop/);
  const diagnostic = JSON.parse(diagnosticText);
  assert.equal(diagnostic.outcome, "error");
  assert.equal(diagnostic.error_kind, "json_parse");
});
