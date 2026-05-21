import * as store from "./store.js";
import { createRegistryRepositoryContract } from "../../../execution-runs/registry/index.js";

export function createJsonRegistryRepository() {
  return createRegistryRepositoryContract({
    appendRunEvent: store.appendRunEvent,
    commitRunTransition: store.commitRunTransition,
    createBatchFromPacketReports: store.createBatchFromPacketReports,
    createRunFromPacketReport: store.createRunFromPacketReport,
    getRegistryPaths: store.getRegistryPaths,
    getRunPaths: store.getRunPaths,
    hashRunSnapshot: store.hashRunSnapshot,
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
