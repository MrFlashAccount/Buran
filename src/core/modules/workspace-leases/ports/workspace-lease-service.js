export const WORKSPACE_LEASE_SERVICE_PORT = "buran.core.workspaceLeases.workspaceLeaseService";

export const WORKSPACE_LEASE_SERVICE_METHODS = Object.freeze([
  "acquire",
  "release",
  "recover",
]);

export class WorkspaceLeaseServicePort {
  static portName = WORKSPACE_LEASE_SERVICE_PORT;
  static methodNames = WORKSPACE_LEASE_SERVICE_METHODS;

  static assert(service) { return assertWorkspaceLeaseService(service); }
}

export function assertWorkspaceLeaseService(service) {
  if (!service || typeof service !== "object") throw new Error("workspaceLeaseService is required");
  for (const methodName of WORKSPACE_LEASE_SERVICE_METHODS) {
    if (typeof service[methodName] !== "function") throw new Error(`workspaceLeaseService.${methodName} must be a function`);
  }
  return service;
}

export function createWorkspaceLeaseServiceContract(service) {
  const checked = assertWorkspaceLeaseService(service);
  return Object.freeze(Object.fromEntries(WORKSPACE_LEASE_SERVICE_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
