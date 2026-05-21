import { isRecord } from "../../../../shared/primitives.js";
import { appendScmHandoffTargetValidationErrors } from "../contract.js";

/**
 * Value object for a validated projected SCM handoff target.
 *
 * The value must satisfy the provider-neutral handoff target schema from `scm-handoff/contract.js`: PR/target number,
 * URL, repo, issue number parity field, head/base branches, state, draft flag, and title. Construction freezes a
 * shallow copy so callers can safely serialize it without mutating the original input.
 */
export class ScmHandoffTarget {
  constructor(value) {
    if (!isRecord(value)) throw new Error("ScmHandoffTarget must be an object");
    const errors = [];
    appendScmHandoffTargetValidationErrors(value, errors, "handoff_target");
    if (errors.length) throw new Error(errors.join("; "));
    this.value = Object.freeze({ ...value });
  }

  toObject() {
    return { ...this.value };
  }

  toJSON() {
    return this.toObject();
  }
}
