/**
 * Port name for the durable lease-record store consumed by workspace lease services.
 *
 * The port is intentionally storage-neutral: implementations may persist records in
 * JSON files, another local store, or a test double, but must preserve exclusive
 * write semantics per lease-record path.
 */
export const LEASE_RECORD_STORE_PORT = "buran.lease-record-store.v1";

/** Required methods for a lease-record store implementation. */
export const LEASE_RECORD_STORE_METHODS = Object.freeze([
  "listLeaseRecords",
  "removeLeaseRecordPath",
  "writeLeaseRecordExclusive",
  "getLeaseRecordPath",
]);

/**
 * Assert that a candidate object implements the lease-record store port.
 *
 * @param {object} store Candidate store.
 * @returns {object} The original store when all required methods are callable.
 * @throws {Error} When the store is absent or a required method is missing.
 */
export function assertLeaseRecordStore(store) {
  if (!store || typeof store !== "object") throw new Error("leaseRecordStore is required");
  for (const methodName of LEASE_RECORD_STORE_METHODS) {
    if (typeof store[methodName] !== "function") throw new Error(`leaseRecordStore.${methodName} must be a function`);
  }
  return store;
}

/**
 * Create a frozen, bound lease-record store contract.
 *
 * @param {object} store Object implementing `listLeaseRecords(registryRoot)`,
 * `removeLeaseRecordPath(recordPath)`, `writeLeaseRecordExclusive(recordPath, record)`,
 * and `getLeaseRecordPath(registryRoot, lockKey)`.
 * @returns {Readonly<object>} Bound contract exposing only the port methods.
 */
export function createLeaseRecordStoreContract(store) {
  const checked = assertLeaseRecordStore(store);
  return Object.freeze(Object.fromEntries(LEASE_RECORD_STORE_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
