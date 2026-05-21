/** Composition root: wires core ports to concrete local integrations. */
import { createJsonRegistryRepository } from "../integrations/storage/json-registry/repository.js";
import { createJsonLeaseRecordStore } from "../integrations/storage/json-registry/lease-record-store.js";
import { createJsonRegistryRecoveryStore } from "../integrations/storage/json-registry/recovery-store.js";
import { createFilesystemWorkspaceLeaseService } from "../integrations/worktree/filesystem/locks.js";
import { createFilesystemWorkspacePreparationInspector } from "../integrations/worktree/filesystem/workspace-preparation-inspector.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { assertWorkspaceLeaseService } from "../core/modules/workspace-leases/ports/workspace-lease-service.js";
import { createLocalJournalScmHandoffAdapter } from "../core/modules/scm-handoff/services/local-journal-scm-handoff-adapter.js";
import { assertScmHandoffPort } from "../core/modules/scm-handoff/ports/scm-handoff-port.js";

export class LocalBuranRuntime {
  constructor({ registryRepository, leaseRecordStore, registryRecoveryStore, workspaceLeaseService, workspacePreparationInspector, scmHandoffAdapter } = {}) {
    this.registryRepository = assertRegistryRepository(registryRepository || createJsonRegistryRepository());
    this.leaseRecordStore = leaseRecordStore || createJsonLeaseRecordStore();
    this.registryRecoveryStore = registryRecoveryStore || createJsonRegistryRecoveryStore();
    this.workspaceLeaseService = assertWorkspaceLeaseService(workspaceLeaseService || createFilesystemWorkspaceLeaseService({
      registryRepository: this.registryRepository,
      leaseRecordStore: this.leaseRecordStore,
    }));
    this.workspacePreparationInspector = workspacePreparationInspector || createFilesystemWorkspacePreparationInspector();
    this.scmHandoffAdapter = assertScmHandoffPort(scmHandoffAdapter || createLocalJournalScmHandoffAdapter());
  }
}

export function createLocalBuranRuntime(options = {}) {
  return new LocalBuranRuntime(options);
}
