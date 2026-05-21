import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";
import { RunId } from "../value-objects/run-id.js";

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

export function executionRunFromSnapshot(snapshot) {
  return new ExecutionRun(snapshot);
}
