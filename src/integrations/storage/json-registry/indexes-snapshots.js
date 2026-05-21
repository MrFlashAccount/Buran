/** Derived index rebuild and snapshot hashing helpers for the JSON registry adapter. */
import { promises as fs } from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION, TERMINAL_STATES } from "../../../core/modules/execution-runs/constants.js";
import { isKnownState } from "../../../core/modules/execution-runs/state-machine.js";
import { canonicalJson, sha256Hex } from "../../../shared/primitives.js";
import { writeJsonAtomic } from "./atomic-read-write.js";
import { getRegistryPaths } from "./path-layout.js";

function scmTargetFromSnapshot(snapshot) {
  if (snapshot?.scm_target && typeof snapshot.scm_target === "object") return snapshot.scm_target;
  if (snapshot?.github && typeof snapshot.github === "object") return snapshot.github;
  return {};
}

function indexEntryFromSnapshot(snapshot) {
  const scmTarget = scmTargetFromSnapshot(snapshot);
  return {
    run_id: snapshot.run_id,
    state: snapshot.state,
    repo: scmTarget.repo || "",
    issue_number: scmTarget.issue_number || null,
    branch: scmTarget.intended_branch || "",
  };
}

function leaseEntryFromSnapshot(snapshot) {
  if (snapshot.workspace?.lease_status !== "acquired" && snapshot.locks?.lease_status !== "acquired") return null;
  const scmTarget = scmTargetFromSnapshot(snapshot);
  return {
    run_id: snapshot.run_id,
    state: snapshot.state,
    lease_id: snapshot.workspace?.lease_id || snapshot.locks?.lease_id || "",
    workspace_id: snapshot.workspace?.id || null,
    workspace_path: snapshot.workspace?.path || null,
    repo: scmTarget.repo || snapshot.locks?.repo || "",
    issue_number: scmTarget.issue_number || snapshot.locks?.issue || null,
    branch: scmTarget.intended_branch || snapshot.locks?.branch || "",
    conflict_surface: snapshot.locks?.conflict_surface || [],
    acquired_at: snapshot.workspace?.acquired_at || snapshot.locks?.acquired_at || "",
    expires_at: snapshot.workspace?.expires_at || snapshot.locks?.expires_at || "",
    lock_keys: snapshot.locks?.lock_keys || [],
  };
}

async function readRunSnapshotFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function isIndexableActiveRun(snapshot) {
  return snapshot?.schema_version === SCHEMA_VERSION && isKnownState(snapshot.state) && !TERMINAL_STATES.has(snapshot.state);
}

/**
 * Rebuilds active-runs and workspace-leases indexes from non-terminal snapshots.
 *
 * @param {string} registryRoot
 * @param {{ clock?: () => Date, snapshots?: Record<string, unknown>[] | null }} [options]
 * @returns {Promise<{ active_runs: Record<string, unknown>[], workspace_leases: Record<string, unknown>[] }>}
 */
export async function rebuildIndexes(registryRoot, { clock = () => new Date(), snapshots = null } = {}) {
  const paths = getRegistryPaths(registryRoot);
  await fs.mkdir(paths.runs, { recursive: true });
  const sourceSnapshots = [];

  if (Array.isArray(snapshots)) {
    sourceSnapshots.push(...snapshots);
  } else {
    const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(paths.runs, entry.name, "run.json");
      try {
        const snapshot = await readRunSnapshotFile(runPath);
        if (!isIndexableActiveRun(snapshot)) continue;
        sourceSnapshots.push(snapshot);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  const activeSnapshots = sourceSnapshots.filter(isIndexableActiveRun);
  const runs = activeSnapshots
    .map(indexEntryFromSnapshot)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
  const leases = activeSnapshots
    .map(leaseEntryFromSnapshot)
    .filter(Boolean)
    .sort((a, b) => a.run_id.localeCompare(b.run_id));

  const updatedAt = clock().toISOString();
  await writeJsonAtomic(paths.activeRuns, {
    schema_version: SCHEMA_VERSION,
    updated_at: updatedAt,
    runs,
  });
  await writeJsonAtomic(paths.workspaceLeases, {
    schema_version: SCHEMA_VERSION,
    updated_at: updatedAt,
    leases,
  });
  return { active_runs: runs, workspace_leases: leases };
}

/**
 * Produces a stable content hash for a run snapshot.
 *
 * @param {unknown} snapshot
 * @returns {string}
 */
export function hashRunSnapshot(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}
