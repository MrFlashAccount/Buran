import { TERMINAL_STATES } from "../execution-runs/constants.js";
import { LEASE_STATUSES } from "./contract.js";

export function isLeaseExpired(expiresAt, now = new Date()) {
  const expires = Date.parse(expiresAt || "");
  return Number.isFinite(expires) && expires <= now.getTime();
}

export function snapshotHasAcquiredLease(snapshot) {
  return snapshot?.workspace?.lease_status === LEASE_STATUSES.ACQUIRED || snapshot?.locks?.lease_status === LEASE_STATUSES.ACQUIRED;
}

export function snapshotLeaseIds(snapshot) {
  return new Set([snapshot?.workspace?.lease_id, snapshot?.locks?.lease_id].filter((value) => typeof value === "string" && value.trim()));
}

export function snapshotLeaseExpiresAt(snapshot) {
  if (snapshot?.workspace?.lease_status === LEASE_STATUSES.ACQUIRED && snapshot.workspace?.expires_at) return snapshot.workspace.expires_at;
  if (snapshot?.locks?.lease_status === LEASE_STATUSES.ACQUIRED && snapshot.locks?.expires_at) return snapshot.locks.expires_at;
  return snapshot?.workspace?.expires_at || snapshot?.locks?.expires_at || "";
}

export function snapshotAllowsRecordConflict(owner, record, now = new Date()) {
  if (!owner) return true;
  if (TERMINAL_STATES.has(owner.state)) return false;
  if (!snapshotHasAcquiredLease(owner)) return false;
  if (isLeaseExpired(snapshotLeaseExpiresAt(owner), now)) return false;
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

export function dedupeConflicts(conflicts) {
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

export function detectLeaseConflictsFromSnapshotsAndRecords(request, snapshots, records, { now = new Date() } = {}) {
  const requested = new Set(request.lock_keys.map((lock) => lock.key));
  const conflicts = [];
  const snapshotByRunId = new Map(snapshots.map((snapshot) => [snapshot.run_id, snapshot]));
  for (const snapshot of snapshots) {
    if (snapshot.run_id === request.run_id) continue;
    if (TERMINAL_STATES.has(snapshot.state)) continue;
    if (!snapshotHasAcquiredLease(snapshot)) continue;
    if (isLeaseExpired(snapshotLeaseExpiresAt(snapshot), now)) continue;
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
  for (const record of records) {
    if (record.corrupt) {
      conflicts.push({ surface: "lease_record", key: record.record_path, owner_run_id: "unknown", reason: "corrupt_lease_record" });
      continue;
    }
    if (!requested.has(record.key)) continue;
    if (record.status && record.status !== LEASE_STATUSES.ACQUIRED) continue;
    if (record.run_id === request.run_id && record.lease_id === request.lease_id) continue;
    if (isLeaseExpired(record.expires_at, now)) continue;
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

export function projectSnapshotWithLease(snapshot, request, status = LEASE_STATUSES.ACQUIRED) {
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

export function projectSnapshotLeaseRelease(snapshot, timestamp, status, reason) {
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

export function classifyLeaseRecoverySnapshot(snapshot, now = new Date()) {
  if (!snapshotHasAcquiredLease(snapshot)) return { action: "keep" };
  if (TERMINAL_STATES.has(snapshot.state)) {
    return {
      action: "release_terminal",
      status: LEASE_STATUSES.RELEASED,
      reason: "terminal run release during recovery",
      finding: "terminal_lease_released",
      severity: "info",
    };
  }
  if (isLeaseExpired(snapshotLeaseExpiresAt(snapshot), now)) {
    return {
      action: "recover_stale",
      status: LEASE_STATUSES.STALE_RECOVERED,
      reason: "lease TTL expired; reclaimed by local recovery policy",
      finding: "stale_lease_reclaimed",
      severity: "warning",
    };
  }
  return { action: "keep" };
}

export function shouldRemoveLeaseRecord(record, owner, now = new Date()) {
  return !owner || !snapshotAllowsRecordConflict(owner, record, now) || isLeaseExpired(record.expires_at, now);
}
