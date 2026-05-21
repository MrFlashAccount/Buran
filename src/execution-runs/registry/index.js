export const REGISTRY_REPOSITORY_PORT = "buran.registry-repository.v1";

export const REGISTRY_REPOSITORY_METHODS = Object.freeze([
  "appendRunEvent",
  "commitRunTransition",
  "createBatchFromPacketReports",
  "createRunFromPacketReport",
  "getRegistryPaths",
  "getRunPaths",
  "hashRunSnapshot",
  "readEventsFile",
  "readRunSnapshot",
  "recordArtifact",
  "recordGateResult",
  "recordProjectionIntent",
  "recordProjectionResult",
  "rebuildIndexes",
  "removeLeaseRecordsForRun",
  "transitionRun",
  "writeRegistryReport",
  "writeRunSnapshot",
]);

export function assertRegistryRepository(repository, { methodNames = REGISTRY_REPOSITORY_METHODS } = {}) {
  if (!repository || typeof repository !== "object") {
    throw new Error("registryRepository is required");
  }
  for (const methodName of methodNames) {
    if (typeof repository[methodName] !== "function") {
      throw new Error(`registryRepository.${methodName} must be a function`);
    }
  }
  return repository;
}

export function createRegistryRepositoryContract(repository) {
  const checked = assertRegistryRepository(repository);
  return Object.freeze(Object.fromEntries(REGISTRY_REPOSITORY_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
