export const LEASE_RECORD_STORE_PORT = "buran.lease-record-store.v1";

export const LEASE_RECORD_STORE_METHODS = Object.freeze([
  "listLeaseRecords",
  "removeLeaseRecordPath",
  "writeLeaseRecordExclusive",
]);

export function assertLeaseRecordStore(store) {
  if (!store || typeof store !== "object") throw new Error("leaseRecordStore is required");
  for (const methodName of LEASE_RECORD_STORE_METHODS) {
    if (typeof store[methodName] !== "function") throw new Error(`leaseRecordStore.${methodName} must be a function`);
  }
  return store;
}

export function createLeaseRecordStoreContract(store) {
  const checked = assertLeaseRecordStore(store);
  return Object.freeze(Object.fromEntries(LEASE_RECORD_STORE_METHODS.map((methodName) => [methodName, checked[methodName].bind(checked)])));
}
