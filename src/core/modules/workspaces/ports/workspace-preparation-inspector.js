export const WORKSPACE_PREPARATION_INSPECTOR_PORT = "buran.core.workspaces.workspacePreparationInspector";

export class WorkspacePreparationInspectorPort {
  static portName = WORKSPACE_PREPARATION_INSPECTOR_PORT;
  static methodNames = Object.freeze(["inspect"]);

  static assert(inspector) { return assertWorkspacePreparationInspector(inspector); }
}

export function assertWorkspacePreparationInspector(inspector) {
  if (!inspector || typeof inspector !== "object") throw new Error("workspacePreparationInspector is required");
  if (typeof inspector.inspect !== "function") throw new Error("workspacePreparationInspector.inspect must be a function");
  return inspector;
}

export function createWorkspacePreparationInspectorContract(inspector) {
  const checked = assertWorkspacePreparationInspector(inspector);
  return Object.freeze({ inspect: checked.inspect.bind(checked) });
}
