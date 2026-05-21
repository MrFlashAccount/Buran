/** Provider-neutral port for acquiring, releasing, and recovering workspace leases. */
export const WORKSPACE_LEASE_SERVICE_PORT = "buran.core.workspaceLeases.workspaceLeaseService";

/** Required workspace lease service methods. */
export const WORKSPACE_LEASE_SERVICE_METHODS = Object.freeze([
  "acquire",
  "release",
  "recover",
]);

/**
 * Public port descriptor for workspace lease services.
 *
 * Implementations coordinate run snapshots with durable lease records. `acquire`
 * must either record a non-overlapping lease or return a blocked lease result;
 * `release` clears lease records for the owning run; `recover` reconciles stale,
 * terminal, orphaned, or corrupt records without taking external provider actions.
 */
export class WorkspaceLeaseServicePort {
  static portName = WORKSPACE_LEASE_SERVICE_PORT;
  static methodNames = WORKSPACE_LEASE_SERVICE_METHODS;

  static assert(service) { return assertWorkspaceLeaseService(service); }
}

/**
 * Assert that a candidate object implements the workspace lease service port.
 *
 * @param {object} service Candidate service.
 * @returns {object} The original service when all required methods are callable.
 */
export function assertWorkspaceLeaseService(service) {
  if (!service || typeof service !== "object") throw new Error("workspaceLeaseService is required");
  for (const methodName of WORKSPACE_LEASE_SERVICE_METHODS) {
    if (typeof service[methodName] !== "function") throw new Error(`workspaceLeaseService.${methodName} must be a function`);
  }
  return service;
}

/**
 * Create a frozen, bound workspace lease service contract.
 *
 * @param {object} service Object implementing `acquire`, `release`, and `recover`.
 * @returns {Readonly<object>} Bound contract exposing only lease-service methods.
 */
export function createWorkspaceLeaseServiceContract(service) {
  const checked = assertWorkspaceLeaseService(service);
  return Object.freeze(Object.fromEntries(WORKSPACE_LEASE_SERVICE_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
