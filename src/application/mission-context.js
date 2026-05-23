/** Mission input/context constants and normalization helpers for local runner orchestration. */

export const RUNNER_MODE = "run_local";
export const RUNNER_ACTOR = "local-mission-runner";

export function hasActiveLease(snapshot) {
  return snapshot?.workspace?.lease_status === "acquired" || snapshot?.locks?.lease_status === "acquired";
}
