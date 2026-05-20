/** Lease-record file helpers for the JSON registry storage adapter. */
import { promises as fs } from "node:fs";
import path from "node:path";

import { leaseRecordsDir } from "./path-layout.js";

/**
 * Removes persisted lease record files associated with a run snapshot.
 *
 * @param {string} registryRoot
 * @param {Record<string, unknown>} snapshot
 * @returns {Promise<string[]>}
 */
export async function removeLeaseRecordsForRun(registryRoot, snapshot) {
  const leasesDir = leaseRecordsDir(registryRoot);
  const entries = await fs.readdir(leasesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const leaseIds = new Set([snapshot.workspace?.lease_id, snapshot.locks?.lease_id].filter((value) => typeof value === "string" && value.trim()));
  const removed = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const recordPath = path.join(leasesDir, entry.name);
    let record;
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      continue;
    }
    if (record?.run_id !== snapshot.run_id) continue;
    if (leaseIds.size > 0 && record.lease_id && !leaseIds.has(record.lease_id)) continue;
    await fs.rm(recordPath, { force: true });
    removed.push(recordPath);
  }

  return removed.sort((a, b) => a.localeCompare(b));
}

/**
 * Deletes a single lease record file if it exists.
 *
 * @param {string} recordPath
 * @returns {Promise<string>}
 */
export async function removeLeaseRecordPath(recordPath) {
  await fs.rm(recordPath, { force: true });
  return recordPath;
}

/**
 * Writes a lease record using exclusive creation semantics.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} record
 * @returns {Promise<{ path: string, record: Record<string, unknown> }>}
 */
export async function writeLeaseRecordExclusive(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: filePath, record };
}
