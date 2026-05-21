import { promises as fs } from "node:fs";

import * as store from "./store.js";
import { createRegistryRepositoryContract } from "../../../core/modules/execution-runs/ports/registry-repository.js";

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
    rebuildIndexes: store.rebuildIndexes,
    removeLeaseRecordsForRun: store.removeLeaseRecordsForRun,
    transitionRun: store.transitionRun,
    writeRegistryReport: store.writeRegistryReport,
    writeRunSnapshot: store.writeRunSnapshot,
  });
}

export const jsonRegistryRepository = createJsonRegistryRepository();
