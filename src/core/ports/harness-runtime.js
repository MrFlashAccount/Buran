/** Provider-neutral HarnessRuntime port contract helpers. */
import { nonEmptyString } from "../../shared/primitives.js";

/**
 * Runtime statuses returned by bounded harness adapters.
 * Core/application code treats these as provider-neutral claims only; registry
 * completion decisions remain the authority for state transitions.
 */
export const HARNESS_STATUSES = Object.freeze(["PENDING", "COMPLETED", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"]);
export const TERMINAL_HARNESS_STATUSES = new Set(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"]);
export const HARNESS_STATUS_SET = new Set(HARNESS_STATUSES);

export function normalizeHarnessStatus(status) {
  const value = nonEmptyString(status).toUpperCase();
  return HARNESS_STATUS_SET.has(value) ? value : "BLOCKED";
}

export function harnessAdapterId(adapter) {
  return nonEmptyString(adapter?.adapter_id || adapter?.adapter || adapter?.id || adapter?.name) || "harness-runtime.v1";
}

export function isHarnessRuntime(adapter) {
  return Boolean(adapter) && (typeof adapter.spawn === "function" || typeof adapter.execute === "function");
}

export function assertHarnessRuntime(adapter) {
  if (!isHarnessRuntime(adapter)) throw new Error("HarnessRuntime must expose spawn(envelope) or execute(envelope)");
  return adapter;
}
