import test from "node:test";
import assert from "node:assert/strict";

import { buildPrProjectionPlan } from "../src/pr-projection-adapter.js";

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

test("PR projection identity includes github.base_branch to avoid stacked PR collisions", () => {
  const clock = () => new Date("2026-05-16T13:57:00.000Z");
  const main = buildPrProjectionPlan(projectionSnapshot("main"), { clock, actor: "test" });
  const develop = buildPrProjectionPlan(projectionSnapshot("develop"), { clock, actor: "test" });

  assert.notEqual(main.intentIdempotencyKey, develop.intentIdempotencyKey);
  assert.notEqual(main.resultIdempotencyKey, develop.resultIdempotencyKey);
  assert.notEqual(main.intentArtifactPath, develop.intentArtifactPath);
  assert.notEqual(main.resultArtifactPath, develop.resultArtifactPath);
  assert.equal(main.intent.intended_pr.base_branch, "main");
  assert.equal(develop.intent.intended_pr.base_branch, "develop");
});
