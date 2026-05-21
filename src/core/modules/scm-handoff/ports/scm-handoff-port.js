/** Explicit provider-neutral SCM handoff port contract. */
import { nonEmptyString } from "../../../../shared/primitives.js";

export const SCM_HANDOFF_PORT = "buran.core.scmHandoff";
export const SCM_HANDOFF_PORT_METHODS = Object.freeze(["plan", "execute"]);

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

export function scmHandoffAdapterName(adapter) {
  return nonEmptyString(adapter?.adapter) || SCM_HANDOFF_PORT;
}
