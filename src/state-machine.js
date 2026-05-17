import {
  ALLOWED_TRANSITIONS,
  ALLOWED_EVENT_TYPES,
  EXECUTION_STATE_SET,
  GATE_NAMES,
  GATE_STATE_BY_NAME,
  GATE_STATUS,
  SCHEMA_VERSION,
  TERMINAL_STATES,
  TRANSITION_METADATA,
} from "./constants.js";
import { isRecord, nonEmptyString } from "./utils.js";

function transitionKey(fromState) {
  return fromState ?? "__start__";
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function buildPendingGateSummary(currentEpoch) {
  return {
    status: GATE_STATUS.PENDING,
    current_epoch: currentEpoch,
    current_attempt: 0,
    recorded_from_state: "",
    artifact_refs: [],
    recorded_at: null,
    actor: "",
    idempotency_key: "",
  };
}

function buildPendingGateSet(currentEpoch) {
  return Object.fromEntries(GATE_NAMES.map((gateName) => [gateName, buildPendingGateSummary(currentEpoch)]));
}

function freshGateStatus(snapshot, gateName, acceptedStatuses) {
  if (!isRecord(snapshot)) return false;
  const currentEpoch = snapshot.execution?.current_epoch;
  const gate = snapshot.gates?.[gateName];
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 1 || !isRecord(gate)) return false;
  if (!acceptedStatuses.includes(gate.status)) return false;
  return gate.current_epoch === currentEpoch && Number.isSafeInteger(gate.current_attempt) && gate.current_attempt >= 1;
}

function validateGateTransitionGuard(snapshot, fromState, toState) {
  if (!isRecord(snapshot)) return { ok: true, reason: "allowed transition" };
  if (snapshot.state !== fromState) {
    return { ok: false, reason: `snapshot state ${snapshot.state} does not match transition from_state ${fromState}` };
  }

  if (fromState === "verification" && toState === "internal_review") {
    if (!freshGateStatus(snapshot, "verification", [GATE_STATUS.PASS])) {
      return { ok: false, reason: "transition verification -> internal_review requires a fresh verification PASS for the current epoch" };
    }
  }
  if (fromState === "verification" && toState === "fix_loop") {
    if (!freshGateStatus(snapshot, "verification", [GATE_STATUS.FAIL])) {
      return { ok: false, reason: "transition verification -> fix_loop requires a current verification FAIL result" };
    }
  }
  if (fromState === "verification" && toState === "blocked_needs_human") {
    if (!freshGateStatus(snapshot, "verification", [GATE_STATUS.BLOCKED])) {
      return { ok: false, reason: "transition verification -> blocked_needs_human requires a current verification BLOCKED result" };
    }
  }
  if (fromState === "internal_review" && toState === "pr_ready") {
    if (!freshGateStatus(snapshot, "verification", [GATE_STATUS.PASS])) {
      return { ok: false, reason: "transition internal_review -> pr_ready requires a fresh verification PASS for the current epoch" };
    }
    if (!freshGateStatus(snapshot, "internal_review", [GATE_STATUS.PASS])) {
      return { ok: false, reason: "transition internal_review -> pr_ready requires a fresh internal_review PASS for the current epoch" };
    }
  }
  if (fromState === "internal_review" && toState === "fix_loop") {
    if (!freshGateStatus(snapshot, "internal_review", [GATE_STATUS.FAIL])) {
      return { ok: false, reason: "transition internal_review -> fix_loop requires a current internal_review FAIL result" };
    }
  }
  if (fromState === "internal_review" && toState === "blocked_needs_human") {
    if (!freshGateStatus(snapshot, "internal_review", [GATE_STATUS.BLOCKED])) {
      return { ok: false, reason: "transition internal_review -> blocked_needs_human requires a current internal_review BLOCKED result" };
    }
  }

  return { ok: true, reason: getTransitionMetadata(fromState, toState)?.reason || "allowed transition" };
}

export function isKnownState(state) {
  return typeof state === "string" && EXECUTION_STATE_SET.has(state);
}

export function isTerminalState(state) {
  return typeof state === "string" && TERMINAL_STATES.has(state);
}

export function getAllowedTransitions(fromState) {
  return ALLOWED_TRANSITIONS[transitionKey(fromState)] || [];
}

export function getTransitionMetadata(fromState, toState) {
  return TRANSITION_METADATA.find((transition) => transition.from === fromState && transition.to === toState) || null;
}

export function validateTransition({ fromState, toState, snapshot = null }) {
  if (fromState !== null && !isKnownState(fromState)) {
    return { ok: false, reason: `unknown from_state: ${fromState}` };
  }
  if (!isKnownState(toState)) {
    return { ok: false, reason: `unknown to_state: ${toState}` };
  }
  if (fromState !== null && isTerminalState(fromState)) {
    return { ok: false, reason: `terminal state ${fromState} cannot transition to ${toState}` };
  }
  const allowed = getAllowedTransitions(fromState);
  if (!allowed.includes(toState)) {
    return {
      ok: false,
      reason: `transition ${fromState ?? "<start>"} -> ${toState} is not allowed; allowed: ${allowed.join(", ") || "none"}`,
    };
  }
  return validateGateTransitionGuard(snapshot, fromState, toState);
}

export function assertTransitionAllowed({ fromState, toState, snapshot = null }) {
  const decision = validateTransition({ fromState, toState, snapshot });
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}

function normalizeTerminalReason(toState, evidence) {
  if (!isTerminalState(toState)) return "";
  if (toState === "ready_for_manual_review") return nonEmptyString(evidence?.reason);
  return nonEmptyString(evidence?.terminal_reason) || nonEmptyString(evidence?.reason) || `Terminal state reached: ${toState}`;
}

function maybeAdvanceExecutionEpoch(snapshot, fromState, toState) {
  if (!isRecord(snapshot)) return { execution: { current_epoch: 0 }, gates: buildPendingGateSet(0) };
  const currentEpoch = Number.isSafeInteger(snapshot.execution?.current_epoch) ? snapshot.execution.current_epoch : 0;
  if (toState === "verification" && (fromState === "running" || fromState === "fix_loop")) {
    const nextEpoch = currentEpoch + 1;
    return {
      execution: {
        ...(snapshot.execution || {}),
        current_epoch: nextEpoch,
      },
      gates: buildPendingGateSet(nextEpoch),
    };
  }
  return {
    execution: snapshot.execution || { current_epoch: currentEpoch },
    gates: snapshot.gates || buildPendingGateSet(currentEpoch),
  };
}

export function gateStateForName(gateName) {
  return GATE_STATE_BY_NAME[gateName] || "";
}

export function applyTransitionToSnapshot(snapshot, { toState, timestamp, evidence = {}, sequence } = {}) {
  if (!isRecord(snapshot)) throw new Error("run snapshot is required");
  assertTransitionAllowed({ fromState: snapshot.state, toState, snapshot });
  const terminal = isTerminalState(toState);
  const nextStateFields = maybeAdvanceExecutionEpoch(snapshot, snapshot.state, toState);
  return {
    ...snapshot,
    state: toState,
    last_sequence: Number.isSafeInteger(sequence) && sequence > 0 ? sequence : snapshot.last_sequence,
    execution: nextStateFields.execution,
    gates: nextStateFields.gates,
    workspace: terminal && snapshot.workspace?.lease_status === "acquired" ? {
      ...snapshot.workspace,
      lease_status: "released",
      released_at: timestamp,
    } : snapshot.workspace,
    locks: terminal && snapshot.locks?.lease_status === "acquired" ? {
      ...snapshot.locks,
      lease_status: "released",
      released_at: timestamp,
    } : snapshot.locks,
    updated_at: timestamp,
    terminal_reason: normalizeTerminalReason(toState, evidence),
  };
}

export function validateTransitionEvent(event, { expectedRunId = "", expectedSequence, expectedFromState } = {}) {
  if (!isRecord(event)) return { ok: false, reason: "event is not an object" };
  if (event.schema_version !== SCHEMA_VERSION) return { ok: false, reason: `unsupported event schema_version: ${event.schema_version}` };
  if (expectedRunId && event.run_id !== expectedRunId) return { ok: false, reason: `event run_id mismatch: ${event.run_id}` };
  if (!Number.isSafeInteger(event.sequence)) return { ok: false, reason: "event sequence is not an integer" };
  if (expectedSequence !== undefined && event.sequence !== expectedSequence) {
    return { ok: false, reason: `event sequence ${event.sequence} is not expected ${expectedSequence}` };
  }
  if (!nonEmptyString(event.timestamp) || Number.isNaN(Date.parse(event.timestamp))) {
    return { ok: false, reason: "event timestamp is missing or invalid" };
  }
  if (!nonEmptyString(event.type)) return { ok: false, reason: "event type is missing" };
  if (!ALLOWED_EVENT_TYPES.has(event.type)) return { ok: false, reason: `unknown event type: ${event.type}` };
  if (!nonEmptyString(event.actor)) return { ok: false, reason: "event actor is missing" };
  if (!hasOwn(event, "evidence") || !isRecord(event.evidence)) return { ok: false, reason: "event evidence is missing or invalid" };
  if (event.type !== "transition") return { ok: true, reason: "non-transition event accepted" };
  if (!hasOwn(event, "state_before")) return { ok: false, reason: "transition event state_before is missing" };
  if (!hasOwn(event, "state_after")) return { ok: false, reason: "transition event state_after is missing" };
  if (event.state_before !== expectedFromState) {
    return { ok: false, reason: `event state_before ${event.state_before ?? "<start>"} is not expected ${expectedFromState ?? "<start>"}` };
  }
  return validateTransition({ fromState: event.state_before, toState: event.state_after });
}

export function buildTransitionEvent({ runId, sequence, timestamp, fromState, toState, actor, evidence = {}, idempotencyKey = "" }) {
  assertTransitionAllowed({ fromState, toState });
  if (!runId) throw new Error("runId is required for transition event");
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("transition event sequence must be a positive integer");
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    sequence,
    timestamp,
    type: "transition",
    state_before: fromState,
    state_after: toState,
    actor: nonEmptyString(actor) || "unknown",
    evidence: isRecord(evidence) ? evidence : {},
    idempotency_key: nonEmptyString(idempotencyKey) || `${runId}:${toState}:${sequence}`,
  };
}

export function buildNonTransitionEvent({ runId, sequence, timestamp, type, actor, evidence = {}, idempotencyKey = "" }) {
  if (!runId) throw new Error("runId is required for event");
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("event sequence must be a positive integer");
  if (!nonEmptyString(type) || type === "transition" || !ALLOWED_EVENT_TYPES.has(type)) throw new Error(`unknown event type: ${type}`);
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    sequence,
    timestamp,
    type,
    actor: nonEmptyString(actor) || "unknown",
    evidence: isRecord(evidence) ? evidence : {},
    idempotency_key: nonEmptyString(idempotencyKey) || `${runId}:${type}:${sequence}`,
  };
}
