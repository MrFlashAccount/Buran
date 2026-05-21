import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";

export class ScmHandoffProjection {
  constructor({ intent = null, result = null, handoffTarget = null } = {}) {
    this.intent = isRecord(intent) ? intent : null;
    this.result = isRecord(result) ? result : null;
    this.handoffTarget = isRecord(handoffTarget) ? handoffTarget : null;
  }

  get adapter() { return nonEmptyString(this.result?.adapter || this.intent?.adapter); }
  get mode() { return nonEmptyString(this.result?.mode || this.intent?.mode); }
  get status() { return nonEmptyString(this.result?.status); }
  isSuccessful(successStatuses = new Set(["projected_local", "projected", "created", "updated"])) {
    return successStatuses.has(this.status);
  }
  toResult() { return this.result; }
}
