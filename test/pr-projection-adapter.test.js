import test from "node:test";
import assert from "node:assert/strict";

import { buildScmHandoffPlan } from "../src/core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js";

function projectionSnapshot(baseBranch) {
  return {
    run_id: "run_projection_base_branch_identity",
    task_id: "projection-base-branch-identity",
    state: "pr_ready",
    execution: { current_epoch: 1 },
    gates: {
      verification: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [] },
      internal_review: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [] },
    },
    github: {
      repo: "example-owner/example-repo",
      issue_number: 17,
      intended_branch: "feature/base-sensitive",
      base_branch: baseBranch,
    },
    projections: {},
  };
}

test("SCM handoff identity includes scm_target.base_branch to avoid stacked PR collisions", () => {
  const clock = () => new Date("2026-05-16T13:57:00.000Z");
  const main = buildScmHandoffPlan(projectionSnapshot("main"), { clock, actor: "test" });
  const develop = buildScmHandoffPlan(projectionSnapshot("develop"), { clock, actor: "test" });

  assert.notEqual(main.intentIdempotencyKey, develop.intentIdempotencyKey);
  assert.notEqual(main.resultIdempotencyKey, develop.resultIdempotencyKey);
  assert.notEqual(main.intentArtifactPath, develop.intentArtifactPath);
  assert.notEqual(main.resultArtifactPath, develop.resultArtifactPath);
  assert.equal(main.intent.intended_handoff_target.base_branch, "main");
  assert.equal(develop.intent.intended_handoff_target.base_branch, "develop");
});
