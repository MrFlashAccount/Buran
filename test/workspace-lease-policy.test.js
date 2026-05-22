import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceLease } from "../src/core/modules/workspace-leases/entities/workspace-lease.js";
import { classifyLeaseRecoverySnapshot, detectLeaseConflictsFromSnapshotsAndRecords } from "../src/core/modules/workspace-leases/policy.js";

const now = new Date("2026-05-22T09:00:00.000Z");

test("workspace lease policy detects conflicts without filesystem or registry roots", () => {
  const request = {
    run_id: "run-contender",
    lease_id: "lease-contender",
    lock_keys: [{ surface: "branch", key: "branch:repo:feature" }],
  };
  const snapshots = [{
    run_id: "run-owner",
    state: "running",
    locks: {
      lease_status: "acquired",
      lease_id: "lease-owner",
      expires_at: "2026-05-22T10:00:00.000Z",
      lock_keys: [{ surface: "branch", key: "branch:repo:feature" }],
    },
  }];

  const conflicts = detectLeaseConflictsFromSnapshotsAndRecords(request, snapshots, [], { now });
  assert.deepEqual(conflicts, [{
    surface: "branch",
    key: "branch:repo:feature",
    owner_run_id: "run-owner",
    owner_lease_id: "lease-owner",
    expires_at: "2026-05-22T10:00:00.000Z",
    reason: "active_run_lock_overlap",
  }]);
});

test("workspace lease entity and recovery policy own active/stale decisions", () => {
  const lease = new WorkspaceLease({
    lease_id: "lease-owner",
    run_id: "run-owner",
    status: "acquired",
    surface: "branch",
    key: "branch:repo:feature",
    expires_at: "2026-05-22T08:00:00.000Z",
  });
  assert.equal(lease.ownerKey, "run-owner:lease-owner");
  assert.equal(lease.isActive(now), false);
  assert.equal(lease.conflictsWith("branch:repo:feature", now), false);
  assert.equal(lease.belongsTo({ runId: "run-owner", leaseId: "lease-owner" }), true);
  assert.deepEqual(lease.toConflict(), {
    surface: "branch",
    key: "branch:repo:feature",
    owner_run_id: "run-owner",
    owner_lease_id: "lease-owner",
    expires_at: "2026-05-22T08:00:00.000Z",
    reason: "active_lock_overlap",
  });

  const decision = classifyLeaseRecoverySnapshot({
    run_id: "run-owner",
    state: "running",
    locks: { lease_status: "acquired", expires_at: "2026-05-22T08:00:00.000Z" },
  }, now);
  assert.equal(decision.action, "recover_stale");
  assert.equal(decision.status, "stale_recovered");
});
