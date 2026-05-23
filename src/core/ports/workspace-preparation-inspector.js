/** Provider-neutral core port for read-only workspace preparation inspection. */
export const WORKSPACE_PREPARATION_INSPECTOR_PORT = "buran.core.workspacePreparationInspector";

/**
 * Public port descriptor for workspace preparation inspectors.
 *
 * Implementations expose `inspect(context)`, where `context` is the application
 * workspace-preparation context. The method must inspect local workspace state and
 * return a preparation report without mutating registry state or performing external writes.
 */
export class WorkspacePreparationInspectorPort {
  static portName = WORKSPACE_PREPARATION_INSPECTOR_PORT;
  static methodNames = Object.freeze(["inspect"]);

  static assert(inspector) { return assertWorkspacePreparationInspector(inspector); }
}

/**
 * Assert that an object implements the workspace-preparation inspector port.
 *
 * @param {object} inspector Candidate inspector with an `inspect(context)` method.
 * @returns {object} The original inspector when valid.
 */
export function assertWorkspacePreparationInspector(inspector) {
  if (!inspector || typeof inspector !== "object") throw new Error("workspacePreparationInspector is required");
  if (typeof inspector.inspect !== "function") throw new Error("workspacePreparationInspector.inspect must be a function");
  return inspector;
}

/**
 * Create a frozen, bound workspace-preparation inspector contract.
 *
 * @param {object} inspector Implementation whose `inspect(context)` method is bound.
 * @returns {{inspect: Function}} Minimal immutable inspector contract.
 */
export function createWorkspacePreparationInspectorContract(inspector) {
  const checked = assertWorkspacePreparationInspector(inspector);
  return Object.freeze({ inspect: checked.inspect.bind(checked) });
}
