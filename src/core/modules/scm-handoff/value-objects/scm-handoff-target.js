import { isRecord } from "../../../../shared/primitives.js";
import { appendScmHandoffTargetValidationErrors } from "../contract.js";

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
