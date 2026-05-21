/** Workspace lease contract semantics shared by filesystem lock adapters. */
import path from "node:path";

import { SCHEMA_VERSION } from "../execution-runs/constants.js";
import { nonEmptyString, safeIdPart, sha256Hex, toStringArray } from "../shared/primitives.js";

export const DEFAULT_LEASE_TTL_MS = 4 * 60 * 60 * 1000;
export const LEASE_STATUSES = Object.freeze({
  NOT_REQUESTED: "not_requested",
  ACQUIRED: "acquired",
  BLOCKED: "blocked",
  RELEASED: "released",
  STALE_RECOVERED: "stale_recovered",
});

export function leaseRecordsDir(registryRoot) {
  return path.join(registryRoot, "leases");
}

function leaseRecordFileName(lockKey) {
  return `${sha256Hex(lockKey)}.json`;
}

export function getLeaseRecordPath(registryRoot, lockKey) {
  return path.join(leaseRecordsDir(registryRoot), leaseRecordFileName(lockKey));
}

function normalizeTtlMs(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LEASE_TTL_MS;
}

function normalizeWorkspaceId(value, runId) {
  const normalized = safeIdPart(value, "");
  return normalized || `workspace-${safeIdPart(runId, "run")}`;
}

function defaultWorkspacePath(registryRoot, workspaceId) {
  return path.join(registryRoot, "workspaces", workspaceId);
}

function normalizeConflictSurfaces(snapshot, extraConflictSurface = []) {
  return [...new Set([
    ...toStringArray(snapshot.locks?.conflict_surface),
    ...toStringArray(extraConflictSurface),
  ])].sort((a, b) => a.localeCompare(b));
}

export function buildLeaseRequest(snapshot, {
  registryRoot,
  workspaceId,
  workspacePath = "",
  ttlMs = DEFAULT_LEASE_TTL_MS,
  conflictSurface = [],
  clock = () => new Date(),
} = {}) {
  if (!snapshot?.run_id) throw new Error("run snapshot with run_id is required");
  if (!registryRoot) throw new Error("registryRoot is required");
  const resolvedWorkspaceId = normalizeWorkspaceId(workspaceId, snapshot.run_id);
  const requestedWorkspacePath = nonEmptyString(workspacePath) || defaultWorkspacePath(registryRoot, resolvedWorkspaceId);
  const resolvedWorkspacePath = path.resolve(requestedWorkspacePath);
  const repo = nonEmptyString(snapshot.scm_target?.repo || snapshot.locks?.repo);
  const issueNumber = Number.isSafeInteger(snapshot.scm_target?.issue_number) ? snapshot.scm_target.issue_number : snapshot.locks?.issue;
  const branch = nonEmptyString(snapshot.scm_target?.intended_branch || snapshot.locks?.branch);
  if (!repo) throw new Error("run repo is required for lease acquisition");
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("run issue number is required for lease acquisition");
  if (!branch) throw new Error("run branch is required for lease acquisition");

  const ttl = normalizeTtlMs(ttlMs);
  const acquiredAt = clock().toISOString();
  const expiresAt = new Date(Date.parse(acquiredAt) + ttl).toISOString();
  const surfaces = normalizeConflictSurfaces(snapshot, conflictSurface);
  const leaseId = `lease_${safeIdPart(snapshot.run_id, "run")}_${safeIdPart(resolvedWorkspaceId, "workspace")}_${Date.parse(acquiredAt)}`;
  const lockKeys = [
    { surface: "workspace", value: resolvedWorkspaceId, key: `workspace:${resolvedWorkspaceId}` },
    { surface: "workspace_path", value: resolvedWorkspacePath, key: `workspace_path:${resolvedWorkspacePath}` },
    { surface: "repo_checkout", value: `${resolvedWorkspacePath}::${repo}`, key: `repo_checkout:${resolvedWorkspacePath}:${repo}` },
    { surface: "issue", value: `${repo}#${issueNumber}`, key: `issue:${repo}#${issueNumber}` },
    { surface: "branch", value: `${repo}:${branch}`, key: `branch:${repo}:${branch}` },
    ...surfaces.map((surface) => ({ surface: "conflict_surface", value: `${repo}:${surface}`, key: `conflict_surface:${repo}:${surface}` })),
  ];

  return {
    schema_version: SCHEMA_VERSION,
    lease_id: leaseId,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    workspace_id: resolvedWorkspaceId,
    workspace_path: resolvedWorkspacePath,
    repo,
    issue_number: issueNumber,
    branch,
    conflict_surface: surfaces,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    ttl_ms: ttl,
    lock_keys: lockKeys,
  };
}
