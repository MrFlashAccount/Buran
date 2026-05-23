import { nonEmptyString } from "../../../../shared/primitives.js";

/**
 * Value object for execution-run identity.
 *
 * A `RunId` is a non-empty string accepted by registry paths, snapshots, and event journals. The value is immutable
 * by convention after construction and serializes to the raw id for JSON/durable contract compatibility.
 */
export class RunId {
  constructor(value) {
    const text = nonEmptyString(value);
    if (!text) throw new Error("RunId requires a non-empty value");
    this.value = text;
  }

  toString() { return this.value; }
  toJSON() { return this.value; }
}

/**
 * Parse and validate a raw execution-run id.
 *
 * @param {unknown} value Candidate id.
 * @returns {RunId} Validated run id value object.
 */
export function parseRunId(value) {
  return new RunId(value);
}
