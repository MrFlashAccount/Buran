import { promises as fs } from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION, TERMINAL_STATES } from "../../../execution-runs/constants.js";
import { buildLeaseRecord, validateLeaseRecord } from "../../../execution-runs/schema/index.js";
import { appendRunEvent, commitRunTransition, getRegistryPaths, getRunPaths, readRunSnapshot, rebuildIndexes, removeLeaseRecordPath, writeLeaseRecordExclusive, writeRunSnapshot } from "../../storage/json-registry/store.js";
import { nonEmptyString, safeIdPart } from "../../../shared/primitives.js";
import { DEFAULT_LEASE_TTL_MS, LEASE_STATUSES, buildLeaseRequest, getLeaseRecordPath, leaseRecordsDir } from "../../../workspace-leases/contract.js";
export { getLeaseRecordPath } from "../../../workspace-leases/contract.js";

function isExpired(expiresAt, now) {
  const expires = Date.parse(expiresAt || "");
  return Number.isFinite(expires) && expires <= now.getTime();
}

async function readLeaseRecord(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listRunSnapshots(registryRoot) {
  const paths = getRegistryPaths(registryRoot);
  const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const runPaths = getRunPaths(registryRoot, entry.name);
      const snapshot = await readRunSnapshot(runPaths.runPath);
      snapshots.push(snapshot);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return snapshots;
}

export async function listLeaseRecords(registryRoot) {
  const dir = leaseRecordsDir(registryRoot);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const record = await readLeaseRecord(filePath);
      if (record) records.push({ ...record, record_path: filePath });
    } catch (error) {
      records.push({ schema_version: "corrupt", record_path: filePath, corrupt: true, error: error?.message || String(error) });
    }
  }
  return records;
}

function snapshotHasAcquiredLease(snapshot) {
  return snapshot?.workspace?.lease_status === LEASE_STATUSES.ACQUIRED || snapshot?.locks?.lease_status === LEASE_STATUSES.ACQUIRED;
}

function snapshotLeaseIds(snapshot) {
  return new Set([snapshot?.workspace?.lease_id, snapshot?.locks?.lease_id].filter((value) => typeof value === "string" && value.trim()));
}

function snapshotLeaseExpiresAt(snapshot) {
  if (snapshot?.workspace?.lease_status === LEASE_STATUSES.ACQUIRED && snapshot.workspace?.expires_at) return snapshot.workspace.expires_at;
  if (snapshot?.locks?.lease_status === LEASE_STATUSES.ACQUIRED && snapshot.locks?.expires_at) return snapshot.locks.expires_at;
  return snapshot?.workspace?.expires_at || snapshot?.locks?.expires_at || "";
}

function snapshotAllowsRecordConflict(owner, record, now) {
  if (!owner) return true;
  if (TERMINAL_STATES.has(owner.state)) return false;
  if (!snapshotHasAcquiredLease(owner)) return false;
  if (isExpired(snapshotLeaseExpiresAt(owner), now)) return false;
  const ownerLeaseIds = snapshotLeaseIds(owner);
  if (ownerLeaseIds.size > 0 && record.lease_id && !ownerLeaseIds.has(record.lease_id)) return false;
  return true;
}

function conflictDedupeKey(conflict) {
  return [
    conflict.surface || "",
    conflict.key || "",
    conflict.owner_run_id || "",
    conflict.owner_lease_id || "",
    conflict.expires_at || "",
  ].join("\u0000");
}

function dedupeConflicts(conflicts) {
  const seen = new Set();
  const deduped = [];
  for (const conflict of conflicts) {
    const key = conflictDedupeKey(conflict);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(conflict);
  }
  return deduped;
}

async function detectConflicts(registryRoot, request, { clock = () => new Date() } = {}) {
  const now = clock();
  const requested = new Set(request.lock_keys.map((lock) => lock.key));
  const conflicts = [];
  const snapshots = await listRunSnapshots(registryRoot);
  const snapshotByRunId = new Map(snapshots.map((snapshot) => [snapshot.run_id, snapshot]));
  for (const snapshot of snapshots) {
    if (snapshot.run_id === request.run_id) continue;
    if (TERMINAL_STATES.has(snapshot.state)) continue;
    if (!snapshotHasAcquiredLease(snapshot)) continue;
    if (isExpired(snapshotLeaseExpiresAt(snapshot), now)) continue;
    for (const lock of snapshot.locks?.lock_keys || []) {
      if (!requested.has(lock.key)) continue;
      conflicts.push({
        surface: lock.surface,
        key: lock.key,
        owner_run_id: snapshot.run_id || "unknown",
        owner_lease_id: snapshot.workspace?.lease_id || snapshot.locks?.lease_id || "unknown",
        expires_at: snapshotLeaseExpiresAt(snapshot),
        reason: "active_run_lock_overlap",
      });
    }
  }
  for (const record of await listLeaseRecords(registryRoot)) {
    if (record.corrupt) {
      conflicts.push({ surface: "lease_record", key: record.record_path, owner_run_id: "unknown", reason: "corrupt_lease_record" });
      continue;
    }
    if (!requested.has(record.key)) continue;
    if (record.status && record.status !== LEASE_STATUSES.ACQUIRED) continue;
    if (record.run_id === request.run_id && record.lease_id === request.lease_id) continue;
    if (isExpired(record.expires_at, now)) continue;
    if (!snapshotAllowsRecordConflict(snapshotByRunId.get(record.run_id), record, now)) continue;
    conflicts.push({
      surface: record.surface,
      key: record.key,
      owner_run_id: record.run_id || "unknown",
      owner_lease_id: record.lease_id || "unknown",
      expires_at: record.expires_at || "",
      reason: "active_lock_overlap",
    });
  }
  return dedupeConflicts(conflicts);
}

async function deleteFiles(paths) {
  for (const filePath of paths.reverse()) {
    await removeLeaseRecordPath(filePath);
  }
}

function withLeaseSnapshot(snapshot, request, status = LEASE_STATUSES.ACQUIRED) {
  return {
    ...snapshot,
    workspace: {
      ...(snapshot.workspace || {}),
      id: request.workspace_id,
      path: request.workspace_path,
      lease_status: status,
      lease_id: request.lease_id,
      acquired_at: request.acquired_at,
      expires_at: request.expires_at,
      ttl_ms: request.ttl_ms,
    },
    locks: {
      ...(snapshot.locks || {}),
      repo: request.repo,
      issue: request.issue_number,
      branch: request.branch,
      conflict_surface: request.conflict_surface,
      lease_status: status,
      lease_id: request.lease_id,
      lock_keys: request.lock_keys,
      acquired_at: request.acquired_at,
      expires_at: request.expires_at,
      ttl_ms: request.ttl_ms,
    },
    updated_at: request.acquired_at,
  };
}

function releaseSnapshot(snapshot, timestamp, status, reason) {
  return {
    ...snapshot,
    workspace: {
      ...(snapshot.workspace || {}),
      lease_status: status,
      released_at: status === LEASE_STATUSES.RELEASED ? timestamp : snapshot.workspace?.released_at,
      stale_recovered_at: status === LEASE_STATUSES.STALE_RECOVERED ? timestamp : snapshot.workspace?.stale_recovered_at,
      stale_recovery_reason: status === LEASE_STATUSES.STALE_RECOVERED ? reason : snapshot.workspace?.stale_recovery_reason,
    },
    locks: {
      ...(snapshot.locks || {}),
      lease_status: status,
      released_at: status === LEASE_STATUSES.RELEASED ? timestamp : snapshot.locks?.released_at,
      stale_recovered_at: status === LEASE_STATUSES.STALE_RECOVERED ? timestamp : snapshot.locks?.stale_recovered_at,
      stale_recovery_reason: status === LEASE_STATUSES.STALE_RECOVERED ? reason : snapshot.locks?.stale_recovery_reason,
    },
    updated_at: timestamp,
  };
}

export async function deleteLeaseRecordsForRun(registryRoot, { runId, leaseId = "" } = {}) {
  const removed = [];
  for (const record of await listLeaseRecords(registryRoot)) {
    if (record.corrupt) continue;
    if (record.run_id !== runId) continue;
    if (leaseId && record.lease_id !== leaseId) continue;
    await removeLeaseRecordPath(record.record_path);
    removed.push(record.record_path);
  }
  return removed;
}

export async function markRunLeaseRecovered(registryRoot, snapshot, { status = LEASE_STATUSES.STALE_RECOVERED, reason, actor = "lease-recovery", clock = () => new Date() } = {}) {
  const timestamp = clock().toISOString();
  const released = releaseSnapshot(snapshot, timestamp, status, reason || status);
  const paths = getRunPaths(registryRoot, snapshot.run_id);
  const removedLeaseRecords = await deleteLeaseRecordsForRun(registryRoot, { runId: snapshot.run_id, leaseId: snapshot.locks?.lease_id || snapshot.workspace?.lease_id || "" });
  const event = await appendRunEvent(paths.runDir, snapshot.run_id, {
    type: status === LEASE_STATUSES.RELEASED ? "lock.lease_released" : "recovery.lease_stale_reclaimed",
    actor,
    evidence: { reason: reason || status, removed_lease_records: removedLeaseRecords.length },
    clock,
    idempotencyKey: `${snapshot.run_id}:${status}:${timestamp}`,
  });
  const nextSnapshot = {
    ...released,
    last_sequence: event.sequence,
    updated_at: event.timestamp,
  };
  await writeRunSnapshot(registryRoot, nextSnapshot);
  return { run: nextSnapshot, removed_lease_records: removedLeaseRecords };
}

export async function releaseWorkspaceLease(registryRoot, runId, { reason = "explicit lease release", actor = "lease-manager", clock = () => new Date() } = {}) {
  const paths = getRunPaths(registryRoot, runId);
  const snapshot = await readRunSnapshot(paths.runPath);
  if (snapshot.workspace?.lease_status !== LEASE_STATUSES.ACQUIRED && snapshot.locks?.lease_status !== LEASE_STATUSES.ACQUIRED) {
    return { status: "no_active_lease", run: snapshot, removed_lease_records: [] };
  }
  const result = await markRunLeaseRecovered(registryRoot, snapshot, { status: LEASE_STATUSES.RELEASED, reason, actor, clock });
  await rebuildIndexes(registryRoot, { clock });
  return { status: "released", ...result };
}

export async function acquireWorkspaceLease(registryRoot, runId, {
  workspaceId,
  workspacePath = "",
  ttlMs = DEFAULT_LEASE_TTL_MS,
  conflictSurface = [],
  actor = "lease-manager",
  clock = () => new Date(),
  beforeWriteLeaseRecord = null,
} = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for lease acquisition");
  const paths = getRunPaths(registryRoot, runId);
  let snapshot = await readRunSnapshot(paths.runPath);
  if (TERMINAL_STATES.has(snapshot.state)) throw new Error(`terminal run ${runId} cannot acquire a lease from state ${snapshot.state}`);
  if (snapshot.state === "queued") {
    const waiting = await commitRunTransition(paths.runDir, snapshot, {
      toState: "waiting_for_lock",
      actor,
      evidence: { reason: "lease acquisition requested" },
      clock,
    });
    snapshot = waiting.run;
  }
  if (snapshot.state !== "waiting_for_lock") throw new Error(`run ${runId} must be queued or waiting_for_lock to acquire a lease; current state: ${snapshot.state}`);

  const request = buildLeaseRequest(snapshot, { registryRoot, workspaceId, workspacePath, ttlMs, conflictSurface, clock });
  const conflicts = await detectConflicts(registryRoot, request, { clock });
  if (conflicts.length > 0) {
    const blocked = await commitRunTransition(paths.runDir, snapshot, {
      toState: "blocked_lock_conflict",
      actor,
      evidence: {
        terminal_reason: `Lock conflict: ${conflicts.map((conflict) => `${conflict.surface}:${conflict.owner_run_id}`).join(", ")}`,
        conflicts,
      },
      clock,
    });
    await rebuildIndexes(registryRoot, { clock });
    return { status: "blocked_lock_conflict", run: blocked.run, conflicts, lease: null, rolled_back_records: 0 };
  }

  const created = [];
  try {
    for (let index = 0; index < request.lock_keys.length; index += 1) {
      const lock = request.lock_keys[index];
      if (typeof beforeWriteLeaseRecord === "function") await beforeWriteLeaseRecord({ index, lock, request, created: [...created] });
      const filePath = getLeaseRecordPath(registryRoot, lock.key);
      const record = buildLeaseRecord(request, lock);
      const decision = validateLeaseRecord(record);
      if (!decision.ok) throw new Error(decision.error);
      await writeLeaseRecordExclusive(filePath, record);
      created.push(filePath);
    }
  } catch (error) {
    await deleteFiles(created);
    const conflict = {
      surface: "lease_record",
      key: request.lock_keys[created.length]?.key || "unknown",
      owner_run_id: "unknown",
      reason: error?.code === "EEXIST" ? "lock_created_concurrently" : "lease_record_write_failed",
      error: error?.message || String(error),
    };
    const blocked = await commitRunTransition(paths.runDir, snapshot, {
      toState: "blocked_lock_conflict",
      actor,
      evidence: {
        terminal_reason: `Lock conflict: ${conflict.reason}`,
        conflicts: [conflict],
        rolled_back_records: created.length,
      },
      clock,
    });
    await rebuildIndexes(registryRoot, { clock });
    return { status: "blocked_lock_conflict", run: blocked.run, conflicts: [conflict], lease: null, rolled_back_records: created.length };
  }

  const snapshotWithLease = withLeaseSnapshot(snapshot, request, LEASE_STATUSES.ACQUIRED);
  await appendRunEvent(paths.runDir, runId, {
    type: "lock.lease_acquired",
    actor,
    evidence: {
      lease_id: request.lease_id,
      workspace_id: request.workspace_id,
      workspace_path: request.workspace_path,
      lock_keys: request.lock_keys,
      expires_at: request.expires_at,
    },
    clock,
    idempotencyKey: `${runId}:lease_acquired:${request.lease_id}`,
  });
  const running = await commitRunTransition(paths.runDir, snapshotWithLease, {
    toState: "running",
    actor,
    evidence: { reason: "workspace lease acquired", lease_id: request.lease_id, expires_at: request.expires_at },
    clock,
  });
  await rebuildIndexes(registryRoot, { clock });
  return { status: "acquired", run: running.run, lease: request, conflicts: [], rolled_back_records: 0 };
}

export async function recoverLeaseRecords(registryRoot, snapshots, { clock = () => new Date() } = {}) {
  const now = clock();
  const findings = [];
  const snapshotByRunId = new Map(snapshots.map((snapshot) => [snapshot.run_id, snapshot]));
  const updatedSnapshots = [];
  const consumedRecordPaths = new Set();

  for (const snapshot of snapshots) {
    let current = snapshot;
    if (snapshotHasAcquiredLease(snapshot)) {
      if (TERMINAL_STATES.has(snapshot.state)) {
        const recovered = await markRunLeaseRecovered(registryRoot, snapshot, {
          status: LEASE_STATUSES.RELEASED,
          reason: "terminal run release during recovery",
          actor: "registry-recovery",
          clock,
        });
        current = recovered.run;
        findings.push({ severity: "info", type: "terminal_lease_released", run_id: snapshot.run_id, removed_lease_records: recovered.removed_lease_records.length });
      } else if (isExpired(snapshotLeaseExpiresAt(snapshot), now)) {
        const recovered = await markRunLeaseRecovered(registryRoot, snapshot, {
          status: LEASE_STATUSES.STALE_RECOVERED,
          reason: "lease TTL expired; reclaimed by local recovery policy",
          actor: "registry-recovery",
          clock,
        });
        current = recovered.run;
        findings.push({ severity: "warning", type: "stale_lease_reclaimed", run_id: snapshot.run_id, removed_lease_records: recovered.removed_lease_records.length });
      }
    }
    updatedSnapshots.push(current);
  }

  for (const record of await listLeaseRecords(registryRoot)) {
    if (record.corrupt) {
      findings.push({ severity: "error", type: "corrupt_lease_record", path: record.record_path, error: record.error });
      continue;
    }
    const owner = snapshotByRunId.get(record.run_id);
    if (!owner || !snapshotAllowsRecordConflict(owner, record, now) || isExpired(record.expires_at, now)) {
      await removeLeaseRecordPath(record.record_path);
      findings.push({ severity: "info", type: "orphan_lease_record_removed", run_id: record.run_id || "", path: record.record_path });
      continue;
    }
    consumedRecordPaths.add(record.record_path);
  }

  return { snapshots: updatedSnapshots, findings, active_lease_record_paths: [...consumedRecordPaths].sort() };
}
