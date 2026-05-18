import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_COMMAND_NAME, PLUGIN_ID } from "./src/constants.js";
import { runBuranCli } from "./src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, "openclaw.plugin.json"), "utf8"));

function getServiceContextField(ctx, field) {
  return ctx && typeof ctx === "object" && typeof ctx[field] === "string" ? ctx[field] : "";
}

function defineLocalPluginEntry({ id, name, description, configSchema, register }) {
  return {
    id,
    name,
    description,
    get configSchema() {
      return configSchema;
    },
    register,
  };
}

export default defineLocalPluginEntry({
  id: PLUGIN_ID,
  name: "Buran",
  description: "Local JSON-first Buran boundary for approved GitHub implementation packets.",
  configSchema: manifest.configSchema,
  register(api) {
    api.registerCommand({
      name: PLUGIN_COMMAND_NAME,
      description: "Validate or intake explicit approved GitHub implementation packet lists.",
      acceptsArgs: true,
      handler: async (ctx = {}) => {
        const result = await runBuranCli(ctx.args || "help", {
          pluginConfig: api.pluginConfig || {},
          workspaceDir: getServiceContextField(ctx, "workspaceDir") || process.cwd(),
          stateDir: getServiceContextField(ctx, "stateDir"),
          apiLogger: api.logger,
        });
        return { text: result.text };
      },
    });
  },
});

export { parseBuranArgs, runBuranCli, usageText } from "./src/cli.js";
export { acquireLeaseReport, formatBuranReport, intakePacketListFile, normalizeBuranConfig, recoverRegistryReport, releaseLeaseReport, runLocalMissionReport, validatePacketListFile } from "./src/buran.js";
export { acquireWorkspaceLease, releaseWorkspaceLease } from "./src/locks.js";
export { normalizePacket, normalizePacketList, summarizePacketReports } from "./src/packet-sufficiency.js";
export { createInvocationObserver, normalizeObservabilityConfig, sanitizeError, sanitizeForObservability } from "./src/observability.js";
export { recoverRegistry } from "./src/recovery.js";
export { createGithubPrTransportAdapter } from "./src/github-pr-transport-adapter.js";
export { buildLocalPrProjection, buildRecordedPrProjection, buildPrProjectionPlan, buildPrProjectionResult, createLocalPrProjectionAdapter } from "./src/pr-projection-adapter.js";
export { runLocalMission } from "./src/runner.js";
export { appendRunEvent, createBatchFromPacketReports, createRunFromPacketReport, getRegistryPaths, rebuildIndexes, transitionRun, writeJsonAtomic } from "./src/registry.js";
export { assertTransitionAllowed, getAllowedTransitions, isTerminalState, validateTransition } from "./src/state-machine.js";
