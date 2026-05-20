export function reviewReadyPolicySnapshot({ runId = "run_policy_ready", state = "ready_for_manual_review" } = {}) {
  const verificationRef = { path: "artifacts/verification/pass.json", sha256: "sha-verification" };
  const reviewRef = { path: "artifacts/internal-review/pass.json", sha256: "sha-review" };
  const projectionRef = { path: "artifacts/pr/projection-result.json", sha256: "sha-projection" };
  const githubPr = {
    number: 99,
    url: "https://github.com/example-owner/example-repo/pull/99",
    repo: "example-owner/example-repo",
    issue_number: 42,
    head_branch: "buran/slice-current",
    base_branch: "buran/slice-previous",
    state: "open",
    draft: true,
    title: "Buran handoff",
    projection_mode: "github_transport",
    projected_at: "2026-05-16T13:57:00.000Z",
    actor: "github-pr-transport-adapter",
  };

  return {
    run_id: runId,
    task_id: "policy-ready-task",
    state,
    execution: { current_epoch: 1 },
    artifacts: {
      packet: { path: "artifacts/packet.json", sha256: "sha-packet" },
      recorded: {
        by_path: {
          "artifacts/implementation-dispatch/result.json": {
            path: "artifacts/implementation-dispatch/result.json",
            sha256: "sha-implementation",
            bytes: 12,
            gate_name: "implementation_dispatch",
            execution_epoch: 0,
            gate_attempt: 1,
            recorded_from_state: "running",
            recorded_at: "2026-05-16T13:54:00.000Z",
            actor: "implementation-harness",
            provenance: { kind: "implementation-dispatch-result", status: "COMPLETED" },
          },
          [verificationRef.path]: {
            path: verificationRef.path,
            sha256: verificationRef.sha256,
            bytes: 12,
            gate_name: "verification",
            execution_epoch: 1,
            gate_attempt: 1,
            recorded_from_state: "verification",
            recorded_at: "2026-05-16T13:55:00.000Z",
            actor: "verification-adapter",
            provenance: { kind: "verification-report" },
          },
          [reviewRef.path]: {
            path: reviewRef.path,
            sha256: reviewRef.sha256,
            bytes: 12,
            gate_name: "internal_review",
            execution_epoch: 1,
            gate_attempt: 1,
            recorded_from_state: "internal_review",
            recorded_at: "2026-05-16T13:56:00.000Z",
            actor: "independent-reviewer",
            provenance: { kind: "internal-review-verdict" },
          },
        },
      },
    },
    gates: {
      verification: {
        status: "PASS",
        current_epoch: 1,
        current_attempt: 1,
        recorded_from_state: "verification",
        artifact_refs: [verificationRef],
      },
      internal_review: {
        status: "PASS",
        current_epoch: 1,
        current_attempt: 1,
        recorded_from_state: "internal_review",
        artifact_refs: [reviewRef],
      },
    },
    github: {
      repo: "example-owner/example-repo",
      issue_number: 42,
      intended_branch: "buran/slice-current",
      base_branch: "buran/slice-previous",
      pr: { ...githubPr },
    },
    projections: {
      github_pr: {
        adapter: "github-pr-transport-adapter",
        mode: "github_transport",
        execution_epoch: 1,
        last_result: {
          status: "created",
          execution_epoch: 1,
          recorded_from_state: "pr_ready",
          artifact_ref: projectionRef,
          idempotency_key: "github.pr:policy:result",
          github_pr: { ...githubPr },
        },
      },
    },
  };
}
