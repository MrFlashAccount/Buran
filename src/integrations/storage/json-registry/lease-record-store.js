import { promises as fs } from "node:fs";
import path from "node:path";

import { createLeaseRecordStoreContract } from "../../../core/modules/workspace-leases/ports/lease-record-store.js";
import { leaseRecordsDir } from "../../../workspace-leases/contract.js";
import { removeLeaseRecordPath, writeLeaseRecordExclusive } from "./lease-records.js";

async function readLeaseRecord(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Create the JSON-registry implementation of the lease-record store port.
 *
 * The adapter reads lease records from `<registryRoot>/leases/*.json`, marks
 * malformed JSON records as corrupt findings instead of throwing during listing,
 * removes records by path, and delegates exclusive file creation to the registry
 * lease-record atomic helpers.
 *
 * @returns {Readonly<object>} Lease-record store contract bound to JSON files.
 */
export function createJsonLeaseRecordStore() {
  return createLeaseRecordStoreContract({
    async listLeaseRecords(registryRoot) {
      const dir = leaseRecordsDir(registryRoot);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      const records = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const record = await readLeaseRecord(filePath);
          if (record) records.push({ ...record, record_path: filePath });
        } catch (error) {
          records.push({ schema_version: "corrupt", record_path: filePath, corrupt: true, error: error?.message || String(error) });
        }
      }
      return records;
    },
    removeLeaseRecordPath,
    writeLeaseRecordExclusive,
  });
}

/** Default JSON lease-record store instance for local composition. */
export const jsonLeaseRecordStore = createJsonLeaseRecordStore();
