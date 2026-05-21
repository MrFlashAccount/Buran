import { createWorkspacePreparationInspectorContract } from "../../../core/modules/workspaces/ports/workspace-preparation-inspector.js";
import { inspectWorkspacePreparation } from "./workspace-preparation.js";

export function createFilesystemWorkspacePreparationInspector() {
  return createWorkspacePreparationInspectorContract({
    inspect: inspectWorkspacePreparation,
  });
}
