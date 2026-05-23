import { createWorkspacePreparationInspectorContract } from "../../../core/ports/workspace-preparation-inspector.js";
import { inspectWorkspacePreparation } from "./workspace-preparation.js";

/**
 * Create the filesystem adapter for the workspace preparation inspector port.
 *
 * Boundary: this adapter inspects the local workspace/worktree state (git status, preparation markers, and related
 * filesystem facts) and returns the provider-neutral preparation report expected by
 * `core/ports/workspace-preparation-inspector.js`. It does not own durable registry persistence.
 *
 * @returns {Readonly<object>} Port-checked workspace preparation inspector.
 */
export function createFilesystemWorkspacePreparationInspector() {
  return createWorkspacePreparationInspectorContract({
    inspect: inspectWorkspacePreparation,
  });
}
