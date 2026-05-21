import test from "node:test";
import assert from "node:assert/strict";

import { assertNextSliceAllowed, evaluateReviewReadyPolicy } from "../src/stack-workflow/review-ready-policy.js";
import { reviewReadyPolicySnapshot } from "./helpers/workflow-policy-fixture.js";

test("workflow policy exposes review-ready gates and allows the next stacked slice only after SCM handoff readiness", () => {
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

  const notReady = evaluateReviewReadyPolicy(reviewReadyPolicySnapshot({ state: "handoff_ready" }), {
    currentSlice: "slice 5",
    nextSlice: "slice 6",
  });
  assert.equal(notReady.status, "blocked");
  assert.equal(notReady.allowed_to_start_next_slice, false);
  assert.ok(notReady.blockers.some((blocker) => blocker.gate === "review_ready_terminal_state"));
  assert.throws(() => assertNextSliceAllowed(reviewReadyPolicySnapshot({ state: "handoff_ready" })), /ready_for_manual_review/);

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

test("workflow policy blocks stale handoff_target data that diverges from the projection result", () => {
  const staleHandoff = structuredClone(reviewReadyPolicySnapshot());
  staleHandoff.handoff_target = {
    ...staleHandoff.handoff_target,
    number: 100,
    url: "https://github.com/example-owner/example-repo/pull/100",
    repo: "unrelated-owner/unrelated-repo",
  };

  const policy = evaluateReviewReadyPolicy(staleHandoff);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.equal(projectionGate.status, "BLOCKED");
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.number must match/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.repo must match/);
});

test("workflow policy blocks missing mirrored projection results", () => {
  const missingMirror = structuredClone(reviewReadyPolicySnapshot());
  delete missingMirror.projection_ledger.handoff_target.last_result.handoff_target;

  const policy = evaluateReviewReadyPolicy(missingMirror);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.equal(projectionGate.status, "BLOCKED");
  assert.ok(projectionGate.evidence.parity_errors.includes("projection_ledger.handoff_target.last_result.handoff_target must be present."));
});

function policyForMirroredHandoffOverride(override) {
  const snapshot = structuredClone(reviewReadyPolicySnapshot());
  const handoffTarget = { ...snapshot.handoff_target, ...override };
  snapshot.handoff_target = { ...handoffTarget };
  snapshot.projection_ledger.handoff_target.last_result.handoff_target = { ...handoffTarget };
  return evaluateReviewReadyPolicy(snapshot);
}

test("workflow policy blocks matching mirrored SCM handoff data that violates the local run contract", () => {
  const policy = policyForMirroredHandoffOverride({
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
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.repo must match scm_target\.repo/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.issue_number must match scm_target\.issue_number/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.head_branch must match scm_target\.intended_branch/);
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.base_branch must match scm_target\.base_branch/);
});

test("workflow policy validates mirrored PR URL schema, host, repo, and number binding", () => {
  for (const { name, url, pattern } of [
    {
      name: "invalid URL syntax",
      url: "not-a-pr-url",
      pattern: /handoff_target\.url must be a valid local:\/\/ or http\(s\):\/\/ PR URL/,
    },
    {
      name: "wrong GitHub host",
      url: "https://evil.example/example-owner/example-repo/pull/99",
      pattern: /handoff_target\.url must bind to https:\/\/github\.com repo and PR number/,
    },
    {
      name: "wrong URL repo",
      url: "https://github.com/example-owner/attacker-repo/pull/99",
      pattern: /handoff_target\.url must bind to https:\/\/github\.com repo and PR number/,
    },
    {
      name: "wrong URL number",
      url: "https://github.com/example-owner/example-repo/pull/100",
      pattern: /handoff_target\.url must bind to https:\/\/github\.com repo and PR number/,
    },
  ]) {
    const policy = policyForMirroredHandoffOverride({ url });
    assert.equal(policy.allowed_to_start_next_slice, false, name);
    const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
    assert.equal(projectionGate.status, "BLOCKED", name);
    assert.match(projectionGate.evidence.parity_errors.join("\n"), pattern, name);
  }
});

test("workflow policy blocks mirrored SCM handoff local contract field mismatches", () => {
  for (const { name, override, pattern } of [
    { name: "wrong repo", override: { repo: "example-owner/attacker-repo", url: "https://github.com/example-owner/attacker-repo/pull/99" }, pattern: /handoff_target\.repo must match scm_target\.repo/ },
    { name: "wrong issue", override: { issue_number: 1000 }, pattern: /handoff_target\.issue_number must match scm_target\.issue_number/ },
    { name: "wrong head", override: { head_branch: "buran/attacker-head" }, pattern: /handoff_target\.head_branch must match scm_target\.intended_branch/ },
    { name: "wrong base", override: { base_branch: "buran/attacker-base" }, pattern: /handoff_target\.base_branch must match scm_target\.base_branch/ },
  ]) {
    const policy = policyForMirroredHandoffOverride(override);
    assert.equal(policy.allowed_to_start_next_slice, false, name);
    const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
    assert.equal(projectionGate.status, "BLOCKED", name);
    assert.match(projectionGate.evidence.parity_errors.join("\n"), pattern, name);
  }
});

test("workflow policy blocks mirrored projection binding mismatches beyond number and URL", () => {
  const wrongHead = structuredClone(reviewReadyPolicySnapshot());
  wrongHead.projection_ledger.handoff_target.last_result.handoff_target = {
    ...wrongHead.projection_ledger.handoff_target.last_result.handoff_target,
    head_branch: "buran/stale-slice",
  };

  const policy = evaluateReviewReadyPolicy(wrongHead);

  assert.equal(policy.allowed_to_start_next_slice, false);
  assert.ok(policy.blockers.some((blocker) => blocker.gate === "pr_projection"));
  const projectionGate = policy.gates.find((gate) => gate.name === "pr_projection");
  assert.match(projectionGate.evidence.parity_errors.join("\n"), /handoff_target\.head_branch must match/);
});
