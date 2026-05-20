/** Public-safe local runner report and transition formatting helpers. */
import { SCHEMA_VERSION } from "../execution-runs/constants.js";
import { implementationDispatchStatusSummary } from "../gates/implementation-contract.js";
import { nonEmptyString } from "../shared/primitives.js";
import { RUNNER_MODE } from "./mission-context.js";

export function buildStep({ action, status, fromState = "", toState = "", detail = "", sequence = null, workspaceId = "", leaseId = "", expiresAt = "", conflicts = 0, rolledBackRecords = 0, artifactPath = "", artifactSha256 = "" } = {}) {
  const step = {
    action,
    status,
    from_state: fromState,
    to_state: toState,
  };
  if (detail) step.detail = detail;
  if (Number.isSafeInteger(sequence)) step.sequence = sequence;
  if (workspaceId) step.workspace_id = workspaceId;
  if (leaseId) step.lease_id = leaseId;
  if (expiresAt) step.expires_at = expiresAt;
  if (conflicts > 0) step.conflicts = conflicts;
  if (rolledBackRecords > 0) step.rolled_back_records = rolledBackRecords;
  if (artifactPath) step.artifact_path = artifactPath;
  if (artifactSha256) step.artifact_sha256 = artifactSha256;
  return step;
}

export function buildIssue(code, message, extra = {}) {
  return { code, message, ...extra };
}

export function buildRunnerReport({
  registryRoot,
  runId,
  previousState = null,
  currentState = null,
  outcome,
  stepsTaken = [],
  blockers = [],
  warnings = [],
  workspacePreparation = null,
  implementationDispatch = null,
  verification = null,
  internalReview = null,
  fixLoop = null,
  projection = null,
  externalSideEffects = false,
  workflowPolicy = null,
} = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    mode: RUNNER_MODE,
    registry_root: registryRoot,
    run_id: runId,
    outcome,
    status: outcome,
    previous_state: previousState,
    current_state: currentState,
    steps_taken: stepsTaken,
    blockers,
    warnings,
    workspace_preparation: workspacePreparation,
    implementation_dispatch: implementationDispatch,
    verification,
    internal_review: internalReview,
    fix_loop: fixLoop,
    projection,
    external_side_effects: Boolean(externalSideEffects),
    workflow_policy: workflowPolicy,
  };
}

export function leaseRequiredMessage(runId) {
  return `Run ${runId} is waiting_for_lock. Acquire a local lease with buran lease acquire --run ${runId} --workspace-id <id> or rerun with --workspace-id.`;
}

export function implementationBoundaryMessage() {
  return "Local mission runner recorded an implementation dispatch handoff but the implementation-harness adapter did not return completed implementation evidence.";
}


export function sanitizeImplementationDispatchProblem(status, problem) {
  if (status === "COMPLETED") return null;
  const fallbackCode = status === "FAILED" ? "implementation_dispatch_failed" : "implementation_dispatch_blocked";
  const code = nonEmptyString(problem?.code).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 120);
  const unsafeCode = /(^|_)(prompt|transcript|stdout|stderr|output|raw|content|body|markdown|log|logs|session)($|_)/i.test(code);
  return buildIssue((code && !unsafeCode) ? code : fallbackCode, implementationDispatchStatusSummary(status));
}

export function unsupportedStageMessage(state) {
  return `Local mission runner skeleton does not execute ${state} adapters yet.`;
}

export function verificationTransition(status) {
  if (status === "PASS") return "internal_review";
  if (status === "FAIL") return "fix_loop";
  return "blocked_needs_human";
}

export function internalReviewTransition(status) {
  if (status === "PASS") return "pr_ready";
  if (status === "FAIL") return "fix_loop";
  return "blocked_needs_human";
}

export function verificationTransitionReason(status) {
  if (status === "PASS") return "verification passed";
  if (status === "FAIL") return "verification failed inside approved scope";
  return "verification blocked on unsupported or unsafe surface";
}

export function internalReviewTransitionReason(status) {
  if (status === "PASS") return "internal review passed";
  if (status === "FAIL") return "internal review failed inside approved scope";
  return "internal review blocked on unsupported or unsafe surface";
}

export function projectionTransitionReason() {
  return "PR handoff recorded";
}

export function projectionProblemCode(suffix) {
  return `pr_projection_${suffix}`;
}
