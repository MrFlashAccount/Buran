/**
 * OpenClaw plugin entry and public export surface for Buran.
 *
 * Responsibilities:
 * - expose the plugin manifest-backed registration contract expected by OpenClaw;
 * - bridge command invocations from the host service into {@link runBuranCli};
 * - re-export stable integration helpers for direct library consumers.
 *
 * Non-goals:
 * - no business logic for packet intake, runner execution, or recovery;
 * - no mutation of plugin config beyond passing the host-provided values through.
 *
 * Invariants:
 * - plugin metadata is loaded from {@code openclaw.plugin.json};
 * - service context fields are treated as optional strings and sanitized before use.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_COMMAND_NAME, PLUGIN_ID } from "./src/execution-runs/constants.js";
import { runBuranCli } from "./src/entrypoints/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, "openclaw.plugin.json"), "utf8"));

/**
 * Read an optional string field from the OpenClaw service invocation context.
 *
 * @param {object | null | undefined} ctx - Service context object supplied by OpenClaw.
 * @param {string} field - Field name expected to contain a string value.
 * @returns {string} Sanitized string value or an empty string when the field is absent.
 */
function getServiceContextField(ctx, field) {
  return ctx && typeof ctx === "object" && typeof ctx[field] === "string" ? ctx[field] : "";
}

/**
 * Lightweight local stand-in for OpenClaw's plugin entry helper.
 *
 * The real host resolves the same shape at runtime; this wrapper keeps the package
 * self-describing for tests and direct imports without introducing a host dependency.
 *
 * @param {object} entry - Plugin definition fields.
 * @param {string} entry.id - Stable plugin identifier.
 * @param {string} entry.name - Human-facing plugin name.
 * @param {string} entry.description - Host-visible plugin description.
 * @param {object} entry.configSchema - JSON-schema-like plugin config contract.
 * @param {(api: object) => void} entry.register - Host registration callback.
 * @returns {{id: string, name: string, description: string, configSchema: object, register: (api: object) => void}} Plugin entry compatible with the local OpenClaw loader.
 */
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

export { parseBuranArgs, runBuranCli, usageText } from "./src/entrypoints/cli.js";
export { acquireLeaseReport, formatBuranReport, intakePacketListFile, normalizeBuranConfig, recoverRegistryReport, releaseLeaseReport, runLocalMissionReport, validatePacketListFile } from "./src/application/commands.js";
export { normalizePacket, normalizePacketList, summarizePacketReports } from "./src/approved-packets/sufficiency.js";
export { createInvocationObserver, normalizeObservabilityConfig, sanitizeError, sanitizeForObservability } from "./src/observability/index.js";
export { recoverRegistry } from "./src/execution-runs/recovery/index.js";
export { createGithubCliPrProjectionAdapter, createGithubCliProjectPr, createGithubPrTransportAdapter } from "./src/integrations/scm/github/pr-transport-adapter.js";
export { runLocalMission } from "./src/application/run-local-mission.js";
export { assertNextSliceAllowed, evaluateReviewReadyPolicy } from "./src/stack-workflow/review-ready-policy.js";
export { REGISTRY_REPOSITORY_METHODS, REGISTRY_REPOSITORY_PORT, assertRegistryRepository, createRegistryRepositoryContract } from "./src/execution-runs/registry/index.js";
export { assertTransitionAllowed, getAllowedTransitions, isTerminalState, validateTransition } from "./src/execution-runs/state-machine.js";
