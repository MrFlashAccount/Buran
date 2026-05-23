import { promises as fs } from "node:fs";

import * as store from "./store.js";
import { createRegistryRepositoryContract } from "../../../core/modules/execution-runs/ports/registry-repository.js";

/**
 * Create the JSON-registry implementation of the execution-runs registry repository port.
 *
 * Implements `core/modules/execution-runs/ports/registry-repository.js` by binding run snapshots, event journals,
 * indexes, artifacts, projection ledger updates, and lease-record cleanup to the durable JSON registry layout.
 * This adapter owns persistence semantics for registry JSON files; callers should depend on the port, not store helpers.
 *
 * @returns {Readonly<object>} Port-checked registry repository backed by local JSON files.
 */
export function createJsonRegistryRepository() {
  return createRegistryRepositoryContract({
    appendRunEvent: store.appendRunEvent,
    commitRunTransition: store.commitRunTransition,
    createBatchFromPacketReports: store.createBatchFromPacketReports,
    createRunFromPacketReport: store.createRunFromPacketReport,
    getRegistryPaths: store.getRegistryPaths,
    getRunPaths: store.getRunPaths,
    hashRunSnapshot: store.hashRunSnapshot,
    async listRunDirs(registryRoot) {
      const paths = store.getRegistryPaths(registryRoot);
      const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    },
    readEventsFile: store.readEventsFile,
    readRunSnapshot: store.readRunSnapshot,
    recordArtifact: store.recordArtifact,
    recordGateResult: store.recordGateResult,
    recordProjectionIntent: store.recordProjectionIntent,
    recordProjectionResult: store.recordProjectionResult,
    recordWorkerTaskCreated: store.recordWorkerTaskCreated,
    recordWorkerTaskDispatch: store.recordWorkerTaskDispatch,
    recordWorkerCompletion: store.recordWorkerCompletion,
    recordWorkerCompletionDecision: store.recordWorkerCompletionDecision,
    recordWorkerTaskOverdue: store.recordWorkerTaskOverdue,
    quarantineWorkerTask: store.quarantineWorkerTask,
    rebuildIndexes: store.rebuildIndexes,
    removeLeaseRecordsForRun: store.removeLeaseRecordsForRun,
    transitionRun: store.transitionRun,
    writeRegistryReport: store.writeRegistryReport,
    writeRunSnapshot: store.writeRunSnapshot,
  });
}

/** Default JSON-registry repository instance for local composition. */
export const jsonRegistryRepository = createJsonRegistryRepository();
