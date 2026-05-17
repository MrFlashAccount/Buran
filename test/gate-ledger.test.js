import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SCHEMA_VERSION } from "../src/constants.js";
import { acquireWorkspaceLease } from "../src/locks.js";
import { recoverRegistry } from "../src/recovery.js";
import {
  createRunFromPacketReport,
  getRunPaths,
  readEventsFile,
  readRunSnapshot,
  recordArtifact,
  recordGateResult,
  transitionRun,
} from "../src/registry-store.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "buran-gate-ledger-test-"));
}

function packetReport(runId = "run_gate_good") {
  return {
    run_id: runId,
    task_id: "gate-good",
    source_path: "/tmp/gate-packets.json",
    packet_hash: "hash-gate-good",
    raw: { task_id: "gate-good", approved: true },
    github: { repo: "MrFlashAccount/example-repo", issue_number: 91, intended_branch: "sergey/gate-good" },
    approval: { approved: true },
    sufficiency_status: "PASS",
    missing_fields: [],
    conflict_surface: ["src/gates"],
    sufficient: true,
  };
}

async function prepareVerificationRun(registryRoot, { runId = "run_gate_good" } = {}) {
  const created = await createRunFromPacketReport(packetReport(runId), {
    registryRoot,
    clock: () => new Date("2026-05-16T13:52:00.000Z"),
  });
  await acquireWorkspaceLease(registryRoot, created.run.run_id, {
    workspaceId: `ws-${runId}`,
    clock: () => new Date("2026-05-16T13:53:00.000Z"),
  });
  const verified = await transitionRun(registryRoot, created.run.run_id, {
    toState: "verification",
    actor: "gate-test-runner",
    evidence: { reason: "implementation completed" },
    clock: () => new Date("2026-05-16T13:54:00.000Z"),
  });
  return verified.run;
}

async function recordVerificationPass(registryRoot, runId) {
  const artifact = await recordArtifact(registryRoot, runId, {
    artifactPath: "artifacts/verification/report.json",
    content: JSON.stringify({ ok: true }, null, 2),
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    actor: "verification-test",
    recorded_at: "2026-05-16T13:55:00.000Z",
    provenance: { kind: "verification-json" },
  });
  const resultPayload = {
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    status: "PASS",
    artifact_refs: [artifact.artifact_ref],
    recorded_at: "2026-05-16T13:56:00.000Z",
    actor: "verification-test",
    idempotency_key: `${runId}:verification:1`,
  };
  const result = await recordGateResult(registryRoot, runId, resultPayload);
  return { artifact, result, resultPayload };
}

test("artifact recording writes immutable ledger state with epoch and attempt provenance", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot);

  const recorded = await recordArtifact(registryRoot, run.run_id, {
    artifactPath: "artifacts/verification/report.json",
    content: JSON.stringify({ ok: true }, null, 2),
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    actor: "verification-test",
    recorded_at: "2026-05-16T13:55:00.000Z",
    provenance: { kind: "verification-json" },
  });

  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.run.last_sequence, recorded.event.sequence);
  assert.equal(recorded.run.execution.current_epoch, 1);
  assert.deepEqual(recorded.run.artifacts.recorded.by_path[recorded.artifact_ref.path], {
    path: recorded.artifact_ref.path,
    sha256: recorded.artifact_ref.sha256,
    bytes: Buffer.byteLength(JSON.stringify({ ok: true }, null, 2)),
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    recorded_at: "2026-05-16T13:55:00.000Z",
    actor: "verification-test",
    provenance: { kind: "verification-json" },
  });

  await assert.rejects(
    () => recordArtifact(registryRoot, run.run_id, {
      artifactPath: "../escape.txt",
      content: "bad",
      gate_name: "verification",
      execution_epoch: 1,
      gate_attempt: 1,
      recorded_from_state: "verification",
      actor: "verification-test",
      recorded_at: "2026-05-16T13:55:01.000Z",
      provenance: {},
    }),
    /escapes the run directory|must stay under artifacts/,
  );
});

test("gate result recording is idempotent and transition guards require fresh current-epoch PASS", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot, { runId: "run_gate_transition_guard" });

  await assert.rejects(
    () => transitionRun(registryRoot, run.run_id, {
      toState: "internal_review",
      actor: "gate-test",
      evidence: { reason: "should fail without gate result" },
      clock: () => new Date("2026-05-16T13:54:30.000Z"),
    }),
    /fresh verification PASS/,
  );

  const { resultPayload } = await recordVerificationPass(registryRoot, run.run_id);
  const noop = await recordGateResult(registryRoot, run.run_id, resultPayload);
  assert.equal(noop.status, "noop");

  const transitioned = await transitionRun(registryRoot, run.run_id, {
    toState: "internal_review",
    actor: "gate-test",
    evidence: { reason: "verification passed" },
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
  });
  assert.equal(transitioned.run.state, "internal_review");
  assert.equal(transitioned.run.gates.verification.status, "PASS");
  assert.equal(transitioned.run.gates.verification.current_epoch, 1);
  assert.equal(transitioned.run.gates.verification.current_attempt, 1);
});

test("internal review gate results open pr_ready on PASS and blocked_needs_human on BLOCKED", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot, { runId: "run_gate_internal_review_paths" });

  await recordVerificationPass(registryRoot, run.run_id);
  await transitionRun(registryRoot, run.run_id, {
    toState: "internal_review",
    actor: "gate-test",
    evidence: { reason: "verification passed" },
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
  });

  const reviewArtifact = await recordArtifact(registryRoot, run.run_id, {
    artifactPath: "artifacts/internal-review/report.json",
    content: JSON.stringify({ status: "PASS" }, null, 2),
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    actor: "review-test",
    recorded_at: "2026-05-16T13:58:00.000Z",
    provenance: { kind: "internal-review-json" },
  });
  await recordGateResult(registryRoot, run.run_id, {
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    status: "PASS",
    artifact_refs: [reviewArtifact.artifact_ref],
    recorded_at: "2026-05-16T13:59:00.000Z",
    actor: "review-test",
    idempotency_key: `${run.run_id}:internal-review:1:pass`,
  });

  const ready = await transitionRun(registryRoot, run.run_id, {
    toState: "pr_ready",
    actor: "gate-test",
    evidence: { reason: "internal review passed" },
    clock: () => new Date("2026-05-16T14:00:00.000Z"),
  });
  assert.equal(ready.run.state, "pr_ready");
  assert.equal(ready.run.gates.internal_review.status, "PASS");

  const blockedRegistryRoot = path.join(tempDir, "registry-blocked");
  const blocked = await prepareVerificationRun(blockedRegistryRoot, { runId: "run_gate_internal_review_blocked" });
  await recordVerificationPass(blockedRegistryRoot, blocked.run_id);
  await transitionRun(blockedRegistryRoot, blocked.run_id, {
    toState: "internal_review",
    actor: "gate-test",
    evidence: { reason: "verification passed" },
    clock: () => new Date("2026-05-16T14:01:00.000Z"),
  });
  const blockedArtifact = await recordArtifact(blockedRegistryRoot, blocked.run_id, {
    artifactPath: "artifacts/internal-review/report.json",
    content: JSON.stringify({ status: "BLOCKED" }, null, 2),
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    actor: "review-test",
    recorded_at: "2026-05-16T14:02:00.000Z",
    provenance: { kind: "internal-review-json" },
  });
  await recordGateResult(blockedRegistryRoot, blocked.run_id, {
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    status: "BLOCKED",
    artifact_refs: [blockedArtifact.artifact_ref],
    recorded_at: "2026-05-16T14:03:00.000Z",
    actor: "review-test",
    idempotency_key: `${blocked.run_id}:internal-review:1:blocked`,
  });

  const blockedNeedsHuman = await transitionRun(blockedRegistryRoot, blocked.run_id, {
    toState: "blocked_needs_human",
    actor: "gate-test",
    evidence: { reason: "internal review blocked on unsupported or unsafe surface" },
    clock: () => new Date("2026-05-16T14:04:00.000Z"),
  });
  assert.equal(blockedNeedsHuman.run.state, "blocked_needs_human");
  assert.equal(blockedNeedsHuman.run.gates.internal_review.status, "BLOCKED");
});

test("new verification epoch resets gate heads and stale PASS no longer opens transitions", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot, { runId: "run_gate_epoch_reset" });

  await recordVerificationPass(registryRoot, run.run_id);
  await transitionRun(registryRoot, run.run_id, {
    toState: "internal_review",
    actor: "gate-test",
    evidence: { reason: "verification passed" },
    clock: () => new Date("2026-05-16T13:57:00.000Z"),
  });

  const reviewArtifact = await recordArtifact(registryRoot, run.run_id, {
    artifactPath: "artifacts/internal-review/review.md",
    content: "needs another pass",
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    actor: "review-test",
    recorded_at: "2026-05-16T13:58:00.000Z",
    provenance: { kind: "internal-review-note" },
  });
  await recordGateResult(registryRoot, run.run_id, {
    gate_name: "internal_review",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "internal_review",
    status: "FAIL",
    artifact_refs: [reviewArtifact.artifact_ref],
    recorded_at: "2026-05-16T13:59:00.000Z",
    actor: "review-test",
    idempotency_key: `${run.run_id}:internal-review:1`,
  });
  await transitionRun(registryRoot, run.run_id, {
    toState: "fix_loop",
    actor: "gate-test",
    evidence: { reason: "internal review failed inside approved scope" },
    clock: () => new Date("2026-05-16T14:00:00.000Z"),
  });

  const reset = await transitionRun(registryRoot, run.run_id, {
    toState: "verification",
    actor: "gate-test",
    evidence: { reason: "fixes applied" },
    clock: () => new Date("2026-05-16T14:01:00.000Z"),
  });

  assert.equal(reset.run.execution.current_epoch, 2);
  assert.deepEqual(reset.run.gates.verification, {
    status: "PENDING",
    current_epoch: 2,
    current_attempt: 0,
    recorded_from_state: "",
    artifact_refs: [],
    recorded_at: null,
    actor: "",
    idempotency_key: "",
  });
  assert.deepEqual(reset.run.gates.internal_review, reset.run.gates.verification);
  await assert.rejects(
    () => transitionRun(registryRoot, run.run_id, {
      toState: "internal_review",
      actor: "gate-test",
      evidence: { reason: "stale pass must not work" },
      clock: () => new Date("2026-05-16T14:01:30.000Z"),
    }),
    /fresh verification PASS/,
  );
});

test("artifact retry repairs stale snapshot from journal without duplicating the event", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot, { runId: "run_gate_artifact_retry" });
  const paths = getRunPaths(registryRoot, run.run_id);
  const staleSnapshot = await readRunSnapshot(paths.runPath);
  const payload = {
    artifactPath: "artifacts/verification/report.json",
    content: JSON.stringify({ ok: true }, null, 2),
    gate_name: "verification",
    execution_epoch: 1,
    gate_attempt: 1,
    recorded_from_state: "verification",
    actor: "verification-test",
    recorded_at: "2026-05-16T13:55:00.000Z",
    provenance: { kind: "verification-json" },
  };

  const recorded = await recordArtifact(registryRoot, run.run_id, payload);
  await fs.writeFile(paths.runPath, `${JSON.stringify(staleSnapshot, null, 2)}\n`, "utf8");

  const eventsBeforeRetry = await readEventsFile(paths.eventsPath);
  const retried = await recordArtifact(registryRoot, run.run_id, payload);
  const eventsAfterRetry = await readEventsFile(paths.eventsPath);
  const repairedSnapshot = await readRunSnapshot(paths.runPath);

  assert.equal(retried.status, "noop");
  assert.equal(retried.event?.sequence, recorded.event.sequence);
  assert.equal(eventsAfterRetry.length, eventsBeforeRetry.length);
  assert.deepEqual(repairedSnapshot.artifacts.recorded.by_path[recorded.artifact_ref.path], recorded.run.artifacts.recorded.by_path[recorded.artifact_ref.path]);
  assert.equal(repairedSnapshot.last_sequence, recorded.event.sequence);

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:05:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 0);
});

test("recovery quarantines conflicting gate-result idempotency payloads", async () => {
  const tempDir = await makeTempDir();
  const registryRoot = path.join(tempDir, "registry");
  const run = await prepareVerificationRun(registryRoot, { runId: "run_gate_conflict" });
  const { artifact_ref, resultPayload } = await (async () => {
    const { artifact, resultPayload } = await recordVerificationPass(registryRoot, run.run_id);
    return { artifact_ref: artifact.artifact_ref, resultPayload };
  })();
  const paths = getRunPaths(registryRoot, run.run_id);
  const events = await readEventsFile(paths.eventsPath);
  await fs.appendFile(paths.eventsPath, `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    run_id: run.run_id,
    sequence: events.length + 1,
    timestamp: "2026-05-16T13:56:30.000Z",
    type: "gate.result_recorded",
    actor: "verification-test",
    evidence: {
      ...resultPayload,
      status: "FAIL",
      artifact_refs: [artifact_ref],
      recorded_at: "2026-05-16T13:56:30.000Z",
    },
    idempotency_key: resultPayload.idempotency_key,
  })}\n`, "utf8");

  const recovery = await recoverRegistry(registryRoot, { clock: () => new Date("2026-05-16T14:05:00.000Z") });
  assert.equal(recovery.summary.quarantined_runs, 1);
  assert.equal(recovery.quarantined[0].reason, "invalid_event_replay");
  const quarantineReport = JSON.parse(await fs.readFile(recovery.quarantined[0].report_path, "utf8"));
  assert.match(quarantineReport.details.error, /idempotency key .* conflicts with a different payload/);
});
