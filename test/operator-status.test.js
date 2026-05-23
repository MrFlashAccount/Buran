import test from "node:test";
import assert from "node:assert/strict";

import { buildOperatorStatusReport } from "../src/application/operator-status.js";
import { statusRunReport, formatBuranReport } from "../src/application/commands.js";
import { SCHEMA_VERSION } from "../src/core/modules/execution-runs/constants.js";

function repository({ snapshot, events = [], snapshotError = null, eventsError = null } = {}) {
  const calls = [];
  return {
    calls,
    getRegistryPaths(registryRoot) {
      calls.push(["getRegistryPaths", registryRoot]);
      return { root: registryRoot, runs: `${registryRoot}/runs`, quarantine: `${registryRoot}/quarantine` };
    },
    getRunPaths(registryRoot, runId) {
      calls.push(["getRunPaths", registryRoot, runId]);
      return {
        runDir: `${registryRoot}/runs/${runId}`,
        runPath: `${registryRoot}/runs/${runId}/run.json`,
        eventsPath: `${registryRoot}/runs/${runId}/events.jsonl`,
        artifactsDir: `${registryRoot}/runs/${runId}/artifacts`,
      };
    },
    async readRunSnapshot(filePath) {
      calls.push(["readRunSnapshot", filePath]);
      if (snapshotError) throw snapshotError;
      return snapshot;
    },
    async readEventsFile(filePath) {
      calls.push(["readEventsFile", filePath]);
      if (eventsError) throw eventsError;
      return events;
    },
  };
}

function activeSnapshot(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: "run_active",
    task_id: "task-active",
    state: "running",
    execution: { current_epoch: 1 },
    workspace: {
      id: "ws-1",
      lease_status: "acquired",
      expires_at: "2026-05-23T20:00:00.000Z",
    },
    locks: { lease_status: "acquired", expires_at: "2026-05-23T20:00:00.000Z" },
    worker_tasks: {
      head: {
        worker_task_id: "wt_1",
        run_id: "run_active",
        task_id: "task-active",
        purpose: "implementation_dispatch",
        role: "implementer",
        epoch: 1,
        attempt: 1,
        authority: "test",
        status: "dispatched",
        created_at: "2026-05-23T18:00:00.000Z",
        updated_at: "2026-05-23T18:00:00.000Z",
        deadline_at: "2026-05-23T19:00:00.000Z",
        dispatch: { intent_ref: { path: "artifacts/implementation-dispatch/intent.json", sha256: "a".repeat(64) } },
      },
    },
    artifacts: {
      recorded: {
        by_path: {
          "artifacts/implementation-dispatch/result.json": {
            path: "artifacts/implementation-dispatch/result.json",
            sha256: "b".repeat(64),
            bytes: 123,
            gate_name: "implementation_dispatch",
            content: "must-not-appear",
          },
        },
      },
    },
    ...overrides,
  };
}

test("operator status returns structured missing run without writes", async () => {
  const notFound = new Error("missing");
  notFound.code = "ENOENT";
  const repo = repository({ snapshotError: notFound });
  repo.writeRunSnapshot = async () => assert.fail("status must not write run snapshots");
  repo.transitionRun = async () => assert.fail("status must not transition runs");

  const report = await buildOperatorStatusReport({ registryRoot: "/tmp/registry", runId: "run_missing", registryRepository: repo });

  assert.equal(report.mode, "status");
  assert.equal(report.status_kind, "missing");
  assert.equal(report.external_side_effects, false);
  assert.equal(report.next_safe_action.kind, "check_run_id");
  assert.deepEqual(repo.calls.map((call) => call[0]), ["getRunPaths", "readRunSnapshot"]);
});

test("operator status summarizes active run from snapshot/events and keeps output public-safe", async () => {
  const repo = repository({
    snapshot: activeSnapshot(),
    events: [
      { type: "policy.decision_recorded", timestamp: "2026-05-23T18:01:00.000Z", evidence: { action_kind: "status.read_registry", decision: "allowed", policy_profile: "local-only", target: { path: "/Users/private/secret.txt", token: "ghp_123456789012345678901234" } } },
      { type: "audit.action_recorded", timestamp: "2026-05-23T18:02:00.000Z", evidence: { action_kind: "remote.write", approval_required: true, external_side_effects: true, result: "denied" } },
    ],
  });

  const report = await buildOperatorStatusReport({
    registryRoot: "/tmp/registry",
    runId: "run_active",
    registryRepository: repo,
    clock: () => new Date("2026-05-23T18:30:00.000Z"),
  });

  assert.equal(report.schema_version, SCHEMA_VERSION);
  assert.equal(report.status_kind, "active");
  assert.equal(report.state, "running");
  assert.equal(report.execution.current_epoch, 1);
  assert.equal(report.workspace.lease_status, "acquired");
  assert.equal(report.worker_task.worker_task_id, "wt_1");
  assert.equal(report.worker_task.status, "dispatched");
  assert.equal(report.artifacts.last[0].path, "artifacts/implementation-dispatch/result.json");
  assert.equal(report.policy.profile, "local-only");
  assert.equal(report.policy.last_decision.decision, "allowed");
  assert.equal(report.audit.external_writes, 1);
  assert.equal(report.audit.approval_gated_actions, 1);
  assert.equal(report.next_safe_action.kind, "wait");
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /must-not-appear|ghp_|secret\.txt|content/);
});

test("operator status reports expired lease and exhausted retry budget read-only", async () => {
  const repo = repository({
    snapshot: activeSnapshot({
      state: "fix_loop",
      workspace: { id: "ws-1", lease_status: "acquired", expires_at: "2026-05-23T17:00:00.000Z" },
      locks: { lease_status: "acquired", expires_at: "2026-05-23T17:00:00.000Z" },
      worker_tasks: { head: null },
      artifacts: {
        recorded: {
          by_path: {
            "artifacts/fix-loop/result-1.json": { path: "artifacts/fix-loop/result-1.json", sha256: "c".repeat(64), gate_name: "fix_attempt", provenance: { kind: "fix-attempt-result" } },
            "artifacts/fix-loop/result-2.json": { path: "artifacts/fix-loop/result-2.json", sha256: "d".repeat(64), gate_name: "fix_attempt", provenance: { kind: "fix-attempt-result" } },
          },
        },
      },
    }),
  });

  const report = await statusRunReport({
    registryRoot: "/tmp/registry",
    runId: "run_active",
    registryRepository: repo,
    clock: () => new Date("2026-05-23T18:30:00.000Z"),
  });

  assert.equal(report.workspace.lease_status, "expired");
  assert.equal(report.workspace.stale_suspected, true);
  assert.equal(report.retry_budgets.find((budget) => budget.name === "fix_loop").exhausted, true);
  assert.equal(report.blockers.some((blocker) => blocker.code === "retry_budget_exhausted"), true);
  assert.equal(report.next_safe_action.kind, "manual_review");
});

test("operator status maps corrupt events to corrupt status", async () => {
  const syntaxError = new SyntaxError("Unexpected token");
  const repo = repository({ snapshot: activeSnapshot(), eventsError: syntaxError });
  const report = await buildOperatorStatusReport({ registryRoot: "/tmp/registry", runId: "run_active", registryRepository: repo });

  assert.equal(report.status_kind, "corrupt");
  assert.equal(report.blockers[0].code, "run_corrupt");
  assert.equal(report.next_safe_action.kind, "recover");
});

test("human status output includes compact operator fields", () => {
  const text = formatBuranReport({
    schema_version: SCHEMA_VERSION,
    mode: "status",
    registry_root: "<registry>",
    run_id: "run_active",
    task_id: "task-active",
    status_kind: "active",
    state: "running",
    execution: { current_epoch: 1, stage: "running", attempt: 1 },
    workspace: { workspace_id: "ws-1", lease_status: "acquired", expires_at: "2026-05-23T20:00:00.000Z", stale_suspected: false },
    worker_task: { worker_task_id: "wt_1", role: "implementer", status: "dispatched", overdue: false },
    artifacts: { last: [{ path: "artifacts/result.json" }] },
    blockers: [],
    policy: { profile: "local-only", last_decision: null, summary: [] },
    audit: { external_writes: 0, approval_gated_actions: 0 },
    retry_budgets: [],
    next_safe_action: { kind: "wait", command: null, reason: "implementation worker task is still pending" },
    external_side_effects: false,
  });

  assert.match(text, /buran: status/);
  assert.match(text, /State: running \(active\)/);
  assert.match(text, /Next safe action: wait/);
  assert.match(text, /External side effects: no/);
});
