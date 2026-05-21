import { nonEmptyString } from "../../../../shared/primitives.js";

export class RunId {
  constructor(value) {
    const text = nonEmptyString(value);
    if (!text) throw new Error("RunId requires a non-empty value");
    this.value = text;
  }

  toString() { return this.value; }
  toJSON() { return this.value; }
}

export function parseRunId(value) {
  return new RunId(value);
}
