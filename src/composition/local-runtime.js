/**
 * Local composition root: wires core ports to concrete local integrations.
 *
 * Defaults:
 * - JSON registry repository for durable snapshots/events/indexes/artifacts;
 * - JSON lease-record store for durable workspace lock files;
 * - JSON registry recovery store for quarantine/recovery reports;
 * - filesystem worktree lease service and preparation inspector;
 * - local journal SCM handoff adapter with no network side effects.
 *
 * Side effects are produced by the composed adapters when their methods are called, not by constructing the runtime.
 */
import { createJsonRegistryRepository } from "../integrations/storage/json-registry/repository.js";
import { createJsonLeaseRecordStore } from "../integrations/storage/json-registry/lease-record-store.js";
import { createJsonRegistryRecoveryStore } from "../integrations/storage/json-registry/recovery-store.js";
import { createFilesystemWorkspaceLeaseService } from "../integrations/worktree/filesystem/locks.js";
import { createFilesystemWorkspacePreparationInspector } from "../integrations/worktree/filesystem/workspace-preparation-inspector.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { assertWorkspaceLeaseService } from "../core/modules/workspace-leases/ports/workspace-lease-service.js";
import { createLocalJournalScmHandoffAdapter } from "../integrations/scm/local-journal/local-journal-scm-handoff-adapter.js";
import { assertScmHandoffPort } from "../core/modules/scm-handoff/ports/scm-handoff-port.js";
import { createWorkspacePreparationInspectorContract } from "../core/ports/workspace-preparation-inspector.js";
import { createOpenClawHarnessAdapter } from "../integrations/harness/openclaw/openclaw-harness-adapter.js";

/**
 * Runtime object exposing the concrete adapters used by local Buran execution.
 *
 * Injected dependencies are accepted per port so tests or alternate compositions can replace storage, lease,
 * preparation, recovery, or SCM handoff behavior independently. Defaults are port-checked where a core assertion
 * exists. The runtime is intentionally a shallow holder: it centralizes construction and dependency wiring, while
 * orchestration remains in application services.
 */
export class LocalBuranRuntime {
  constructor({ registryRepository, leaseRecordStore, registryRecoveryStore, workspaceLeaseService, workspacePreparationInspector, scmHandoffAdapter, harnessRuntime, openClawController } = {}) {
    this.registryRepository = assertRegistryRepository(registryRepository || createJsonRegistryRepository());
    this.leaseRecordStore = leaseRecordStore || createJsonLeaseRecordStore();
    this.registryRecoveryStore = registryRecoveryStore || createJsonRegistryRecoveryStore();
    this.workspaceLeaseService = assertWorkspaceLeaseService(workspaceLeaseService || createFilesystemWorkspaceLeaseService({
      registryRepository: this.registryRepository,
      leaseRecordStore: this.leaseRecordStore,
    }));
    this.workspacePreparationInspector = createWorkspacePreparationInspectorContract(workspacePreparationInspector || createFilesystemWorkspacePreparationInspector());
    this.scmHandoffAdapter = assertScmHandoffPort(scmHandoffAdapter || createLocalJournalScmHandoffAdapter());
    this.harnessRuntime = harnessRuntime || createOpenClawHarnessAdapter({ controller: openClawController });
    this.implementationDispatchAdapter = this.harnessRuntime;
  }
}

/**
 * Create a local runtime composition.
 *
 * @param {object} [options] Optional port implementations overriding local defaults.
 * @returns {LocalBuranRuntime} Runtime with registry, lease, recovery, worktree, and SCM handoff adapters.
 */
export function createLocalBuranRuntime(options = {}) {
  return new LocalBuranRuntime(options);
}
