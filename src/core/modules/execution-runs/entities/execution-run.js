import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";
import { RunId } from "../value-objects/run-id.js";

/**
 * Entity wrapper around a durable execution-run snapshot.
 *
 * Ownership: the instance keeps the supplied snapshot reference and does not clone it; callers that need
 * immutability must freeze or copy before construction. Getters expose normalized read-only views, while
 * `toSnapshot()` intentionally returns the same snapshot object for registry/state-machine flows that own mutation.
 *
 * Public surface:
 * - `id` is a validated `RunId`;
 * - `state` and `currentEpoch` read the current durable state;
 * - `gate(name)` returns a gate summary or `null`;
 * - `scmTarget()` prefers provider-neutral `scm_target` and falls back to legacy `github`;
 * - `hasState(state)` is a convenience predicate.
 */
export class ExecutionRun {
  constructor(snapshot = {}) {
    if (!isRecord(snapshot)) throw new Error("ExecutionRun snapshot must be an object");
    this.snapshot = snapshot;
    this.id = new RunId(snapshot.run_id);
  }

  get state() { return nonEmptyString(this.snapshot.state); }
  get currentEpoch() { return this.snapshot.execution?.current_epoch || 0; }
  hasState(state) { return this.state === state; }
  gate(name) { return isRecord(this.snapshot.gates?.[name]) ? this.snapshot.gates[name] : null; }
  scmTarget() { return isRecord(this.snapshot.scm_target) ? this.snapshot.scm_target : (isRecord(this.snapshot.github) ? this.snapshot.github : {}); }
  toSnapshot() { return this.snapshot; }
}

/**
 * Rehydrate an execution-run entity from a durable snapshot.
 *
 * @param {object} snapshot Durable run snapshot.
 * @returns {ExecutionRun} Entity wrapper over the supplied snapshot reference.
 */
export function executionRunFromSnapshot(snapshot) {
  return new ExecutionRun(snapshot);
}
