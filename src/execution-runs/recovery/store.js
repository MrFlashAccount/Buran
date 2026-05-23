export const REGISTRY_RECOVERY_STORE_PORT = "buran.registry-recovery-store.v1";

export const REGISTRY_RECOVERY_STORE_METHODS = Object.freeze([
  "ensureRunsDir",
  "listRunDirs",
  "readRunJson",
  "readRunEventsText",
  "readArtifactContent",
  "quarantineRun",
  "writeRecoveryReport",
]);

export function assertRegistryRecoveryStore(store) {
  if (!store || typeof store !== "object") throw new Error("registryRecoveryStore is required");
  for (const methodName of REGISTRY_RECOVERY_STORE_METHODS) {
    if (typeof store[methodName] !== "function") throw new Error(`registryRecoveryStore.${methodName} must be a function`);
  }
  return store;
}

export function createRegistryRecoveryStoreContract(store) {
  const checked = assertRegistryRecoveryStore(store);
  return Object.freeze(Object.fromEntries(REGISTRY_RECOVERY_STORE_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
