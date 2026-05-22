import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";
import { LEASE_STATUSES } from "../contract.js";
import { isLeaseExpired } from "../policy.js";

/**
 * Value object for a durable workspace lease record.
 *
 * The entity normalizes the persisted lease identity, owner, status, expiry, and lock key contract so conflict and
 * recovery code can reason about lease records without knowing the storage adapter that loaded them.
 */
export class WorkspaceLease {
  constructor(record = {}) {
    if (!isRecord(record)) throw new Error("WorkspaceLease record must be an object");
    this.record = record;
  }

  get id() { return nonEmptyString(this.record.lease_id); }
  get runId() { return nonEmptyString(this.record.run_id); }
  get workspaceId() { return nonEmptyString(this.record.workspace_id); }
  get workspacePath() { return nonEmptyString(this.record.workspace_path); }
  get surface() { return nonEmptyString(this.record.surface); }
  get key() { return nonEmptyString(this.record.key); }
  get ownerKey() { return this.runId && this.id ? `${this.runId}:${this.id}` : ""; }
  get status() { return nonEmptyString(this.record.status) || LEASE_STATUSES.ACQUIRED; }
  get isAcquired() { return this.status === LEASE_STATUSES.ACQUIRED; }

  expiresAtDate() {
    const expiresAt = Date.parse(this.record.expires_at || "");
    return Number.isFinite(expiresAt) ? new Date(expiresAt) : null;
  }

  isExpired(now = new Date()) {
    return isLeaseExpired(this.record.expires_at, now);
  }

  isActive(now = new Date()) {
    return this.isAcquired && !this.isExpired(now);
  }

  conflictsWith(lockKey, now = new Date()) {
    if (!this.isActive(now)) return false;
    return this.key === nonEmptyString(lockKey);
  }

  belongsTo({ runId = "", leaseId = "" } = {}) {
    if (runId && this.runId !== runId) return false;
    if (leaseId && this.id !== leaseId) return false;
    return true;
  }

  toConflict({ reason = "active_lock_overlap" } = {}) {
    return {
      surface: this.surface,
      key: this.key,
      owner_run_id: this.runId || "unknown",
      owner_lease_id: this.id || "unknown",
      expires_at: this.record.expires_at || "",
      reason,
    };
  }

  toRecord() { return this.record; }
}
