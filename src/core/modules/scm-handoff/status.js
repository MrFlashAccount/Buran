/** Canonical provider-neutral SCM handoff projection statuses. */
import { nonEmptyString } from "../../../shared/primitives.js";

export const SUCCESSFUL_PROJECTION_RESULT_STATUS_VALUES = Object.freeze(["projected_local", "projected", "created", "updated"]);
export const SUCCESSFUL_PROJECTION_RESULT_STATUSES = new Set(SUCCESSFUL_PROJECTION_RESULT_STATUS_VALUES);

export function isSuccessfulProjectionResultStatus(status) {
  return SUCCESSFUL_PROJECTION_RESULT_STATUSES.has(nonEmptyString(status));
}
