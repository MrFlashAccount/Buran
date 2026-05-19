/**
 * Shared execution-run constants consumed by the registry, transition engine, and recovery flow.
 *
 * Responsibilities:
 * - define the canonical state machine vocabulary;
 * - expose immutable lookup tables for gates, artifact stages, and event types;
 * - keep schema-versioned string literals centralized so persistence and replay stay aligned.
 *
 * Non-goals:
 * - runtime validation or transition enforcement;
 * - deriving user-facing messages beyond stable transition reasons.
 */
export const PLUGIN_ID = "buran";
export const PLUGIN_COMMAND_NAME = "buran";
export const SCHEMA_VERSION = "execution-run.v2";

export const EXECUTION_STATES = Object.freeze([
  "packet_received",
  "queued",
  "waiting_for_lock",
  "running",
  "verification",
  "internal_review",
  "fix_loop",
  "pr_ready",
  "blocked_plan_insufficient",
  "blocked_lock_conflict",
  "blocked_needs_human",
  "failed_execution",
  "ready_for_manual_review",
]);

export const TERMINAL_STATE_NAMES = Object.freeze([
  "blocked_plan_insufficient",
  "blocked_lock_conflict",
  "blocked_needs_human",
  "failed_execution",
  "ready_for_manual_review",
]);

export const TERMINAL_STATES = new Set(TERMINAL_STATE_NAMES);
export const EXECUTION_STATE_SET = new Set(EXECUTION_STATES);

export const GATE_NAMES = Object.freeze(["verification", "internal_review"]);
export const GATE_STATE_BY_NAME = Object.freeze({
  verification: "verification",
  internal_review: "internal_review",
});
export const ARTIFACT_STAGE_STATE_BY_NAME = Object.freeze({
  workspace_preparation: "running",
  implementation_dispatch: "running",
  fix_attempt: "fix_loop",
  verification: "verification",
  internal_review: "internal_review",
});
export const ARTIFACT_STAGE_NAMES = Object.freeze(Object.keys(ARTIFACT_STAGE_STATE_BY_NAME));
export const GATE_RESULT_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"]);
export const GATE_STATUS = Object.freeze({
  PENDING: "PENDING",
  PASS: "PASS",
  FAIL: "FAIL",
  BLOCKED: "BLOCKED",
});
export const GATE_STATUS_SET = new Set(Object.values(GATE_STATUS));

export const TRANSITION_METADATA = Object.freeze([
  { from: null, to: "packet_received", reason: "approved packet received" },
  { from: "packet_received", to: "queued", reason: "packet sufficiency passed" },
  { from: "packet_received", to: "blocked_plan_insufficient", reason: "packet sufficiency failed" },
  { from: "queued", to: "waiting_for_lock", reason: "accepted into manual batch" },
  { from: "waiting_for_lock", to: "running", reason: "workspace lease acquired" },
  { from: "waiting_for_lock", to: "blocked_lock_conflict", reason: "unsafe lock overlap" },
  { from: "running", to: "verification", reason: "implementation completed" },
  { from: "running", to: "failed_execution", reason: "unrecoverable implementation failure" },
  { from: "verification", to: "internal_review", reason: "verification passed" },
  { from: "verification", to: "fix_loop", reason: "verification failed inside approved scope" },
  { from: "verification", to: "blocked_needs_human", reason: "verification blocked on unsupported or unsafe surface" },
  { from: "internal_review", to: "pr_ready", reason: "internal review passed" },
  { from: "internal_review", to: "fix_loop", reason: "internal review failed inside approved scope" },
  { from: "internal_review", to: "blocked_needs_human", reason: "internal review blocked on unsupported or unsafe surface" },
  { from: "fix_loop", to: "verification", reason: "fixes applied" },
  { from: "fix_loop", to: "blocked_needs_human", reason: "fix envelope exceeded" },
  { from: "pr_ready", to: "ready_for_manual_review", reason: "PR handoff recorded" },
]);

export const NON_TRANSITION_EVENT_TYPES = Object.freeze([
  "artifact.recorded",
  "gate.result_recorded",
  "lock.lease_acquired",
  "lock.lease_released",
  "lock.lease_blocked",
  "projection.intent_recorded",
  "projection.result_recorded",
  "recovery.lease_stale_reclaimed",
  "recovery.lease_record_removed",
]);

export const ALLOWED_EVENT_TYPES = new Set(["transition", ...NON_TRANSITION_EVENT_TYPES]);

export const ALLOWED_TRANSITIONS = Object.freeze(TRANSITION_METADATA.reduce((accumulator, transition) => {
  const key = transition.from ?? "__start__";
  accumulator[key] = Object.freeze([...(accumulator[key] || []), transition.to]);
  return accumulator;
}, {}));

export const SUFFICIENCY_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
});
