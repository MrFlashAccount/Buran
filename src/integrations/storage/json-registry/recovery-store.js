import { promises as fs } from "node:fs";
import path from "node:path";

import { createRegistryRecoveryStoreContract } from "../../../execution-runs/recovery/store.js";

function safeReasonPart(reason) {
  return String(reason || "invalid")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "invalid";
}

export function createJsonRegistryRecoveryStore() {
  return createRegistryRecoveryStoreContract({
    async ensureRunsDir({ paths }) {
      await fs.mkdir(paths.runs, { recursive: true });
    },
    async listRunDirs({ paths }) {
      const entries = await fs.readdir(paths.runs, { withFileTypes: true }).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    },
    async readRunJson({ runPath }) {
      return JSON.parse(await fs.readFile(runPath, "utf8"));
    },
    async readRunEventsText({ eventsPath }) {
      return fs.readFile(eventsPath, "utf8");
    },
    async readArtifactContent({ artifactPath }) {
      return fs.readFile(artifactPath);
    },
    async quarantineRun({ paths, runDir, runId, reason, details, clock, registryRepository }) {
      const timestamp = clock().toISOString().replace(/\D/g, "").slice(0, 14) || "undated";
      const targetDir = path.join(paths.quarantine, `${timestamp}_${runId}_${safeReasonPart(reason)}`);
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.rename(runDir, targetDir);
      const reportPath = path.join(targetDir, "quarantine-report.json");
      const report = {
        schema_version: "buran.registry.v1",
        quarantined_at: clock().toISOString(),
        run_id: runId,
        reason,
        details,
        original_run_dir: runDir,
        quarantine_dir: targetDir,
        human_needed: true,
      };
      await registryRepository.writeRegistryReport(reportPath, report);
      return { run_id: runId, reason, quarantine_dir: targetDir, report_path: reportPath };
    },
    async writeRecoveryReport({ paths, report, registryRepository }) {
      await registryRepository.writeRegistryReport(path.join(paths.indexes, "recovery-report.json"), report);
    },
  });
}

export const jsonRegistryRecoveryStore = createJsonRegistryRecoveryStore();
