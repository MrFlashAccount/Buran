/** Provider-neutral port for execution-run registry persistence. */
export const REGISTRY_REPOSITORY_PORT = "buran.core.executionRuns.registryRepository";

/** Required registry repository methods used by intake, runner, recovery, and handoff flows. */
export const REGISTRY_REPOSITORY_METHODS = Object.freeze([
  "appendRunEvent",
  "commitRunTransition",
  "createBatchFromPacketReports",
  "createRunFromPacketReport",
  "getRegistryPaths",
  "getRunPaths",
  "hashRunSnapshot",
  "listRunDirs",
  "readEventsFile",
  "readRunSnapshot",
  "recordArtifact",
  "recordGateResult",
  "recordProjectionIntent",
  "recordProjectionResult",
  "recordWorkerTaskCreated",
  "recordWorkerTaskDispatch",
  "recordWorkerCompletion",
  "recordWorkerCompletionDecision",
  "recordWorkerTaskOverdue",
  "quarantineWorkerTask",
  "rebuildIndexes",
  "removeLeaseRecordsForRun",
  "transitionRun",
  "writeRegistryReport",
  "writeRunSnapshot",
]);

/**
 * Public port descriptor for registry repositories.
 *
 * Implementations own durable run snapshots, event journals, artifacts, gate results,
 * projection intents/results, derived indexes, and lease cleanup hooks. Methods must
 * preserve append/transition ordering and expose path helpers without requiring callers
 * to know the concrete storage layout.
 */
export class RegistryRepositoryPort {
  static portName = REGISTRY_REPOSITORY_PORT;
  static methodNames = REGISTRY_REPOSITORY_METHODS;

  static assert(repository, options = {}) {
    return assertRegistryRepository(repository, options);
  }
}

/**
 * Assert that a candidate object implements the registry repository port.
 *
 * @param {object} repository Candidate repository.
 * @param {{methodNames?: readonly string[]}} [options] Optional narrowed method set for tests or partial seams.
 * @returns {object} The original repository when all requested methods are callable.
 */
export function assertRegistryRepository(repository, { methodNames = REGISTRY_REPOSITORY_METHODS } = {}) {
  if (!repository || typeof repository !== "object") throw new Error("registryRepository is required");
  for (const methodName of methodNames) {
    if (typeof repository[methodName] !== "function") throw new Error(`registryRepository.${methodName} must be a function`);
  }
  return repository;
}

/**
 * Create a frozen, bound registry repository contract.
 *
 * @param {object} repository Complete registry repository implementation.
 * @returns {Readonly<object>} Bound contract exposing only registry repository methods.
 */
export function createRegistryRepositoryContract(repository) {
  const checked = assertRegistryRepository(repository);
  return Object.freeze(Object.fromEntries(REGISTRY_REPOSITORY_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
