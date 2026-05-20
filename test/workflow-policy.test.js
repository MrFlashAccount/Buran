import test from "node:test";
import assert from "node:assert/strict";

import { assertNextSliceAllowed, evaluateReviewReadyPolicy } from "../src/workflow-policy.js";
import { reviewReadyPolicySnapshot } from "./helpers/workflow-policy-fixture.js";

test("workflow policy exposes review-ready gates and allows the next stacked slice only after PR readiness", () => {
  const readyPolicy = evaluateReviewReadyPolicy(reviewReadyPolicySnapshot(), {
    currentSlice: "slice 5",
    nextSlice: "slice 6",
  });

  assert.equal(readyPolicy.status, "review_ready");
  assert.equal(readyPolicy.allowed_to_start_next_slice, true);
  assert.deepEqual(readyPolicy.gates.map((gate) => [gate.name, gate.status]), [
    ["architect_contract", "PASS"],
    ["implementation_handoff", "PASS"],
    ["verification", "PASS"],
    ["independent_review", "PASS"],
    ["pr_projection", "PASS"],
    ["review_ready_terminal_state", "PASS"],
  ]);
  assert.doesNotThrow(() => assertNextSliceAllowed(reviewReadyPolicySnapshot()));

  const notReady = evaluateReviewReadyPolicy(reviewReadyPolicySnapshot({ state: "pr_ready" }), {
    currentSlice: "slice 5",
    nextSlice: "slice 6",
  });
  assert.equal(notReady.status, "blocked");
  assert.equal(notReady.allowed_to_start_next_slice, false);
  assert.ok(notReady.blockers.some((blocker) => blocker.gate === "review_ready_terminal_state"));
  assert.throws(() => assertNextSliceAllowed(reviewReadyPolicySnapshot({ state: "pr_ready" })), /ready_for_manual_review/);

  const intentOnly = structuredClone(reviewReadyPolicySnapshot());
  intentOnly.artifacts.recorded.by_path["artifacts/implementation-dispatch/result.json"].provenance = {
    kind: "implementation-dispatch-intent",
    status: "COMPLETED",
  };
  const blockedIntentOnly = evaluateReviewReadyPolicy(intentOnly);
  assert.equal(blockedIntentOnly.allowed_to_start_next_slice, false);
  assert.ok(blockedIntentOnly.blockers.some((blocker) => blocker.gate === "implementation_handoff"));

  const blockedDispatch = structuredClone(reviewReadyPolicySnapshot());
  blockedDispatch.artifacts.recorded.by_path["artifacts/implementation-dispatch/result.json"].provenance.status = "BLOCKED";
  const blockedImplementation = evaluateReviewReadyPolicy(blockedDispatch);
  assert.equal(blockedImplementation.allowed_to_start_next_slice, false);
  assert.ok(blockedImplementation.blockers.some((blocker) => blocker.gate === "implementation_handoff"));
});

test("workflow policy blocks stale github.pr data that diverges from the projection result", () => {
  const stalePr = structuredClone(reviewReadyPolicySnapshot());
  stalePr.github.pr = {
    ...stalePr.github.pr,
    number: 100,
    url: "https://github.com/example-owner/example-repo/pull/100",
    repo: "unrelated-owner/unrelated-repo",
  };

  const policy = evaluateReviewReadyPolicy(stalePr);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.equal(projectionGate.status, "BLOCKED");
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.number must match/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.repo must match/);
});

test("workflow policy blocks missing mirrored projection results", () => {
  const missingMirror = structuredClone(reviewReadyPolicySnapshot());
  delete missingMirror.projections.github_pr.last_result.github_pr;

  const policy = evaluateReviewReadyPolicy(missingMirror);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.equal(projectionGate.status, "BLOCKED");
  assert.ok(projectionGate.evidence.parity_errors.includes("projections.github_pr.last_result.github_pr must be present."));
});

function policyForMirroredPrOverride(override) {
  const snapshot = structuredClone(reviewReadyPolicySnapshot());
  const pr = { ...snapshot.github.pr, ...override };
  snapshot.github.pr = { ...pr };
  snapshot.projections.github_pr.last_result.github_pr = { ...pr };
  return evaluateReviewReadyPolicy(snapshot);
}

test("workflow policy blocks matching mirrored PR data that violates the local run contract", () => {
  const policy = policyForMirroredPrOverride({
    number: 777,
    url: "https://github.com/attacker-owner/attacker-repo/pull/777",
    repo: "attacker-owner/attacker-repo",
    issue_number: 777,
    head_branch: "attacker/head",
    base_branch: "attacker/base",
  });

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.equal(projectionGate.status, "BLOCKED");
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.repo must match github\.repo/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.issue_number must match github\.issue_number/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.head_branch must match github\.intended_branch/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.base_branch must match github\.base_branch/);
});

test("workflow policy validates mirrored PR URL schema, host, repo, and number binding", () => {
  for (const { name, url, pattern } of [
    {
      name: "invalid URL syntax",
      url: "not-a-pr-url",
      pattern: /github\.pr\.url must be a valid local:\/\/ or http\(s\):\/\/ PR URL/,
    },
    {
      name: "wrong GitHub host",
      url: "https://evil.example/example-owner/example-repo/pull/99",
      pattern: /github\.pr\.url must bind to https:\/\/github\.com repo and PR number/,
    },
    {
      name: "wrong URL repo",
      url: "https://github.com/example-owner/attacker-repo/pull/99",
      pattern: /github\.pr\.url must bind to https:\/\/github\.com repo and PR number/,
    },
    {
      name: "wrong URL number",
      url: "https://github.com/example-owner/example-repo/pull/100",
      pattern: /github\.pr\.url must bind to https:\/\/github\.com repo and PR number/,
    },
  ]) {
    const policy = policyForMirroredPrOverride({ url });
    assert.equal(policy.allowed_to_start_next_slice, false, name);
    const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
    assert.equal(projectionGate.status, "BLOCKED", name);
    assert.match(projectionGate.evidence.parity_errors.join("\n"), pattern, name);
  }
});

test("workflow policy blocks mirrored PR local contract field mismatches", () => {
  for (const { name, override, pattern } of [
    { name: "wrong repo", override: { repo: "example-owner/attacker-repo", url: "https://github.com/example-owner/attacker-repo/pull/99" }, pattern: /github\.pr\.repo must match github\.repo/ },
    { name: "wrong issue", override: { issue_number: 1000 }, pattern: /github\.pr\.issue_number must match github\.issue_number/ },
    { name: "wrong head", override: { head_branch: "buran/attacker-head" }, pattern: /github\.pr\.head_branch must match github\.intended_branch/ },
    { name: "wrong base", override: { base_branch: "buran/attacker-base" }, pattern: /github\.pr\.base_branch must match github\.base_branch/ },
  ]) {
    const policy = policyForMirroredPrOverride(override);
    assert.equal(policy.allowed_to_start_next_slice, false, name);
    const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
    assert.equal(projectionGate.status, "BLOCKED", name);
    assert.match(projectionGate.evidence.parity_errors.join("\n"), pattern, name);
  }
});

test("workflow policy blocks mirrored projection binding mismatches beyond number and URL", () => {
  const wrongHead = structuredClone(reviewReadyPolicySnapshot());
  wrongHead.projections.github_pr.last_result.github_pr = {
    ...wrongHead.projections.github_pr.last_result.github_pr,
    head_branch: "buran/stale-slice",
  };

  const policy = evaluateReviewReadyPolicy(wrongHead);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /github\.pr\.head_branch must match/);
});
