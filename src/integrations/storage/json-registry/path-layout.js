/** Canonical JSON registry path layout helpers. */
import path from "node:path";

import { sha256Hex } from "../../../shared/primitives.js";

/**
 * Returns canonical registry-level file and directory paths.
 *
 * @param {string} registryRoot
 * @returns {{ root: string, runs: string, batches: string, indexes: string, quarantine: string, activeRuns: string, workspaceLeases: string }}
 */
export function getRegistryPaths(registryRoot) {
  return {
    root: registryRoot,
    runs: path.join(registryRoot, "runs"),
    batches: path.join(registryRoot, "batches"),
    indexes: path.join(registryRoot, "indexes"),
    quarantine: path.join(registryRoot, "quarantine"),
    activeRuns: path.join(registryRoot, "indexes", "active-runs.json"),
    workspaceLeases: path.join(registryRoot, "indexes", "workspace-leases.json"),
  };
}

/**
 * Returns the canonical filesystem layout for a single run.
 *
 * @param {string} registryRoot
 * @param {string} runId
 * @returns {{ runDir: string, runPath: string, eventsPath: string, artifactsDir: string }}
 */
export function getRunPaths(registryRoot, runId) {
  const runDir = path.join(getRegistryPaths(registryRoot).runs, runId);
  return {
    runDir,
    runPath: path.join(runDir, "run.json"),
    eventsPath: path.join(runDir, "events.jsonl"),
    artifactsDir: path.join(runDir, "artifacts"),
  };
}

export function leaseRecordsDir(registryRoot) {
  return path.join(registryRoot, "leases");
}


function leaseRecordFileName(lockKey) {
  return `${sha256Hex(lockKey)}.json`;
}

export function getLeaseRecordPath(registryRoot, lockKey) {
  return path.join(leaseRecordsDir(registryRoot), leaseRecordFileName(lockKey));
}
