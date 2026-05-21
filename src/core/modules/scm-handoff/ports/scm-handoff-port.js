/** Explicit provider-neutral SCM handoff port contract. */
import { nonEmptyString } from "../../../../shared/primitives.js";

/** Provider-neutral port for planning and executing local SCM handoff projections. */
export const SCM_HANDOFF_PORT = "buran.core.scmHandoff";
/** Required SCM handoff adapter methods. */
export const SCM_HANDOFF_PORT_METHODS = Object.freeze(["plan", "execute"]);

/**
 * Assert that an object implements the SCM handoff port.
 *
 * @param {object} adapter Candidate adapter with `plan(snapshot, options)` and `execute(snapshot, plan)`.
 * @param {{fieldPath?: string}} [options] Label used in validation errors.
 * @returns {object} The original adapter when valid.
 */
export function assertScmHandoffPort(adapter, { fieldPath = "scmHandoffAdapter" } = {}) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`${fieldPath} must implement ${SCM_HANDOFF_PORT}`);
  }
  const missing = SCM_HANDOFF_PORT_METHODS.filter((method) => typeof adapter[method] !== "function");
  if (missing.length > 0) {
    throw new Error(`${fieldPath} must implement ${SCM_HANDOFF_PORT} methods: ${missing.join(", ")}`);
  }
  return adapter;
}

/**
 * Return the public adapter name used in reports.
 *
 * @param {object} adapter SCM handoff adapter or nullish value.
 * @returns {string} Non-empty adapter identifier, or the generic port name.
 */
export function scmHandoffAdapterName(adapter) {
  return nonEmptyString(adapter?.adapter) || SCM_HANDOFF_PORT;
}
