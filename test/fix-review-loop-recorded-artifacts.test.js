import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runFixLoopStage } from "../src/application/fix-review-loop.js";
import { REGISTRY_REPOSITORY_METHODS } from "../src/core/modules/execution-runs/ports/registry-repository.js";

function registryRepositoryWithRunDir(runDir) {
  const repository = Object.fromEntries(REGISTRY_REPOSITORY_METHODS.map((methodName) => [methodName, async () => {
    throw new Error(`${methodName} should not be called by unsafe fix-attempt resume test`);
  }]));
  repository.getRunPaths = () => ({ runDir });
  return repository;
}

test("fix loop resume rejects recorded fix-attempt artifacts with traversal paths", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "buran-fix-loop-"));
  const current = {
    run_id: "run_fix_loop_traversal",
    task_id: "task_fix_loop_traversal",
    state: "fix_loop",
    execution: { current_epoch: 2 },
    workspace: { id: "workspace-main" },
    artifacts: {
      recorded: {
        by_path: {
          "artifacts/../run.json": {
            gate_name: "fix_attempt",
            recorded_from_state: "fix_loop",
            execution_epoch: 2,
            path: "artifacts/../run.json",
            sha256: "deadbeef",
            recorded_at: "2026-05-16T13:57:00.000Z",
            provenance: { kind: "fix-attempt-result", fix_attempt: 1 },
          },
        },
      },
    },
  };

  const report = await runFixLoopStage({
    registryRoot: path.dirname(runDir),
    runId: current.run_id,
    current,
    previousState: "internal_review",
    stepsTaken: [],
    blockers: [],
    warnings: [],
    registryRepository: registryRepositoryWithRunDir(runDir),
  });

  assert.equal(report.outcome, "blocked");
  assert.equal(report.blockers[0].code, "fix_attempt_result_artifact_unsafe_path");
  assert.match(report.blockers[0].message, /not a safe recorded artifact path/);
  assert.equal(report.steps_taken[0].action, "fix_attempt_resume");
});
