import { TERMINAL_STATES } from "../../../core/modules/execution-runs/constants.js";
import { assertRegistryRepository } from "../../../core/modules/execution-runs/ports/registry-repository.js";
import { buildLeaseRecord, validateLeaseRecord } from "../../../execution-runs/schema/index.js";
import { DEFAULT_LEASE_TTL_MS, LEASE_STATUSES, buildLeaseRequest } from "../../../core/modules/workspace-leases/contract.js";
import {
  classifyLeaseRecoverySnapshot,
  detectLeaseConflictsFromSnapshotsAndRecords,
  projectSnapshotLeaseRelease,
  projectSnapshotWithLease,
  shouldRemoveLeaseRecord,
} from "../../../core/modules/workspace-leases/policy.js";
import { assertLeaseRecordStore } from "../../../core/modules/workspace-leases/ports/lease-record-store.js";
import { createWorkspaceLeaseServiceContract } from "../../../core/modules/workspace-leases/ports/workspace-lease-service.js";

async function listRunSnapshots(registryRoot, registryRepository) {
  const registry = assertRegistryRepository(registryRepository);
  const entries = await registry.listRunDirs(registryRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const snapshots = [];
  for (const entry of entries) {
    const runId = typeof entry === "string" ? entry : entry.name;
    try {
      const runPaths = registry.getRunPaths(registryRoot, runId);
      snapshots.push(await registry.readRunSnapshot(runPaths.runPath));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return snapshots;
}

async function detectConflicts(registryRoot, request, { clock = () => new Date(), registryRepository, leaseRecordStore } = {}) {
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  const snapshots = await listRunSnapshots(registryRoot, registryRepository);
  const records = await leaseStore.listLeaseRecords(registryRoot);
  return detectLeaseConflictsFromSnapshotsAndRecords(request, snapshots, records, { now: clock() });
}

async function deleteFiles(paths, leaseRecordStore) {
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  for (const filePath of paths.reverse()) {
    await leaseStore.removeLeaseRecordPath(filePath);
  }
}

export async function deleteLeaseRecordsForRun(registryRoot, { runId, leaseId = "", leaseRecordStore } = {}) {
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  const removed = [];
  for (const record of await leaseStore.listLeaseRecords(registryRoot)) {
    if (record.corrupt) continue;
    if (record.run_id !== runId) continue;
    if (leaseId && record.lease_id !== leaseId) continue;
    await leaseStore.removeLeaseRecordPath(record.record_path);
    removed.push(record.record_path);
  }
  return removed;
}

export async function markRunLeaseRecovered(registryRoot, snapshot, { status = LEASE_STATUSES.STALE_RECOVERED, reason, actor = "lease-recovery", clock = () => new Date(), registryRepository, leaseRecordStore } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const timestamp = clock().toISOString();
  const released = projectSnapshotLeaseRelease(snapshot, timestamp, status, reason || status);
  const paths = registry.getRunPaths(registryRoot, snapshot.run_id);
  const removedLeaseRecords = await deleteLeaseRecordsForRun(registryRoot, { runId: snapshot.run_id, leaseId: snapshot.locks?.lease_id || snapshot.workspace?.lease_id || "", leaseRecordStore });
  const event = await registry.appendRunEvent(paths.runDir, snapshot.run_id, {
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
  await registry.writeRunSnapshot(registryRoot, nextSnapshot);
  return { run: nextSnapshot, removed_lease_records: removedLeaseRecords };
}

export async function releaseWorkspaceLease(registryRoot, runId, { reason = "explicit lease release", actor = "lease-manager", clock = () => new Date(), registryRepository, leaseRecordStore } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const paths = registry.getRunPaths(registryRoot, runId);
  const snapshot = await registry.readRunSnapshot(paths.runPath);
  if (snapshot.workspace?.lease_status !== LEASE_STATUSES.ACQUIRED && snapshot.locks?.lease_status !== LEASE_STATUSES.ACQUIRED) {
    return { status: "no_active_lease", run: snapshot, removed_lease_records: [] };
  }
  const result = await markRunLeaseRecovered(registryRoot, snapshot, { status: LEASE_STATUSES.RELEASED, reason, actor, clock, registryRepository: registry, leaseRecordStore });
  await registry.rebuildIndexes(registryRoot, { clock });
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
  registryRepository,
  leaseRecordStore,
} = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for lease acquisition");
  const registry = assertRegistryRepository(registryRepository);
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  const paths = registry.getRunPaths(registryRoot, runId);
  let snapshot = await registry.readRunSnapshot(paths.runPath);
  if (TERMINAL_STATES.has(snapshot.state)) throw new Error(`terminal run ${runId} cannot acquire a lease from state ${snapshot.state}`);
  if (snapshot.state === "queued") {
    const waiting = await registry.commitRunTransition(paths.runDir, snapshot, {
      toState: "waiting_for_lock",
      actor,
      evidence: { reason: "lease acquisition requested" },
      clock,
    });
    snapshot = waiting.run;
  }
  if (snapshot.state !== "waiting_for_lock") throw new Error(`run ${runId} must be queued or waiting_for_lock to acquire a lease; current state: ${snapshot.state}`);

  const request = buildLeaseRequest(snapshot, { registryRoot, workspaceId, workspacePath, ttlMs, conflictSurface, clock });
  const conflicts = await detectConflicts(registryRoot, request, { clock, registryRepository: registry, leaseRecordStore: leaseStore });
  if (conflicts.length > 0) {
    const blocked = await registry.commitRunTransition(paths.runDir, snapshot, {
      toState: "blocked_lock_conflict",
      actor,
      evidence: {
        terminal_reason: `Lock conflict: ${conflicts.map((conflict) => `${conflict.surface}:${conflict.owner_run_id}`).join(", ")}`,
        conflicts,
      },
      clock,
    });
    await registry.rebuildIndexes(registryRoot, { clock });
    return { status: "blocked_lock_conflict", run: blocked.run, conflicts, lease: null, rolled_back_records: 0 };
  }

  const created = [];
  try {
    for (let index = 0; index < request.lock_keys.length; index += 1) {
      const lock = request.lock_keys[index];
      if (typeof beforeWriteLeaseRecord === "function") await beforeWriteLeaseRecord({ index, lock, request, created: [...created] });
      const filePath = leaseStore.getLeaseRecordPath(registryRoot, lock.key);
      const record = buildLeaseRecord(request, lock);
      const decision = validateLeaseRecord(record);
      if (!decision.ok) throw new Error(decision.error);
      await leaseStore.writeLeaseRecordExclusive(filePath, record);
      created.push(filePath);
    }
  } catch (error) {
    await deleteFiles(created, leaseStore);
    const conflict = {
      surface: "lease_record",
      key: request.lock_keys[created.length]?.key || "unknown",
      owner_run_id: "unknown",
      reason: error?.code === "EEXIST" ? "lock_created_concurrently" : "lease_record_write_failed",
      error: error?.message || String(error),
    };
    const blocked = await registry.commitRunTransition(paths.runDir, snapshot, {
      toState: "blocked_lock_conflict",
      actor,
      evidence: {
        terminal_reason: `Lock conflict: ${conflict.reason}`,
        conflicts: [conflict],
        rolled_back_records: created.length,
      },
      clock,
    });
    await registry.rebuildIndexes(registryRoot, { clock });
    return { status: "blocked_lock_conflict", run: blocked.run, conflicts: [conflict], lease: null, rolled_back_records: created.length };
  }

  const snapshotWithLease = projectSnapshotWithLease(snapshot, request, LEASE_STATUSES.ACQUIRED);
  await registry.appendRunEvent(paths.runDir, runId, {
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
  const running = await registry.commitRunTransition(paths.runDir, snapshotWithLease, {
    toState: "running",
    actor,
    evidence: { reason: "workspace lease acquired", lease_id: request.lease_id, expires_at: request.expires_at },
    clock,
  });
  await registry.rebuildIndexes(registryRoot, { clock });
  return { status: "acquired", run: running.run, lease: request, conflicts: [], rolled_back_records: 0 };
}

export async function recoverLeaseRecords(registryRoot, snapshots, { clock = () => new Date(), registryRepository, leaseRecordStore } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  const now = clock();
  const findings = [];
  const snapshotByRunId = new Map(snapshots.map((snapshot) => [snapshot.run_id, snapshot]));
  const updatedSnapshots = [];
  const consumedRecordPaths = new Set();

  for (const snapshot of snapshots) {
    let current = snapshot;
    const decision = classifyLeaseRecoverySnapshot(snapshot, now);
    if (decision.action !== "keep") {
      const recovered = await markRunLeaseRecovered(registryRoot, snapshot, {
        status: decision.status,
        reason: decision.reason,
        actor: "registry-recovery",
        clock,
        registryRepository: registry,
        leaseRecordStore: leaseStore,
      });
      current = recovered.run;
      findings.push({ severity: decision.severity, type: decision.finding, run_id: snapshot.run_id, removed_lease_records: recovered.removed_lease_records.length });
    }
    updatedSnapshots.push(current);
  }

  for (const record of await leaseStore.listLeaseRecords(registryRoot)) {
    if (record.corrupt) {
      findings.push({ severity: "error", type: "corrupt_lease_record", path: record.record_path, error: record.error });
      continue;
    }
    const owner = snapshotByRunId.get(record.run_id);
    if (shouldRemoveLeaseRecord(record, owner, now)) {
      await leaseStore.removeLeaseRecordPath(record.record_path);
      findings.push({ severity: "info", type: "orphan_lease_record_removed", run_id: record.run_id || "", path: record.record_path });
      continue;
    }
    consumedRecordPaths.add(record.record_path);
  }

  return { snapshots: updatedSnapshots, findings, active_lease_record_paths: [...consumedRecordPaths].sort() };
}

/**
 * Create the filesystem/worktree workspace lease service.
 *
 * @param {{registryRepository: object, leaseRecordStore: object}} deps Dependencies:
 * `registryRepository` supplies run snapshots/transitions/artifact paths, while
 * `leaseRecordStore` supplies durable exclusive lock records.
 * @returns {Readonly<object>} Workspace lease service with `acquire`, `release`, and `recover`.
 * @throws {Error} When required dependencies do not satisfy their ports.
 */
export function createFilesystemWorkspaceLeaseService({ registryRepository, leaseRecordStore } = {}) {
  const registry = assertRegistryRepository(registryRepository);
  const leaseStore = assertLeaseRecordStore(leaseRecordStore);
  return createWorkspaceLeaseServiceContract({
    acquire: (registryRoot, runId, options = {}) => acquireWorkspaceLease(registryRoot, runId, { ...options, registryRepository: registry, leaseRecordStore: leaseStore }),
    release: (registryRoot, runId, options = {}) => releaseWorkspaceLease(registryRoot, runId, { ...options, registryRepository: registry, leaseRecordStore: leaseStore }),
    recover: (registryRoot, snapshots, options = {}) => recoverLeaseRecords(registryRoot, snapshots, { ...options, registryRepository: registry, leaseRecordStore: leaseStore }),
  });
}
