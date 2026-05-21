import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";

/**
 * Read model for the latest SCM handoff projection ledger entries on a run snapshot.
 *
 * It may carry an intent, a result, and the projected `handoffTarget`; all inputs are accepted only when they are
 * records. `adapter`, `mode`, and `status` prefer result data over intent data so callers see the effective
 * projection outcome. `isSuccessful()` uses provider-neutral success statuses by default.
 */
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
