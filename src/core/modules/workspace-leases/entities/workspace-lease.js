import { isRecord, nonEmptyString } from "../../../../shared/primitives.js";

export class WorkspaceLease {
  constructor(record = {}) {
    if (!isRecord(record)) throw new Error("WorkspaceLease record must be an object");
    this.record = record;
  }

  get id() { return nonEmptyString(this.record.lease_id); }
  get runId() { return nonEmptyString(this.record.run_id); }
  get workspaceId() { return nonEmptyString(this.record.workspace_id); }
  get workspacePath() { return nonEmptyString(this.record.workspace_path); }
  expiresAtDate() { return this.record.expires_at ? new Date(this.record.expires_at) : null; }
  isExpired(now = new Date()) {
    const expiresAt = this.expiresAtDate();
    return expiresAt instanceof Date && !Number.isNaN(expiresAt.valueOf()) && expiresAt <= now;
  }
  toRecord() { return this.record; }
}
