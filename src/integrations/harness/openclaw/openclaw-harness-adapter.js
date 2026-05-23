/** OpenClaw concrete harness adapter shim. */
import { nonEmptyString } from "../../../shared/primitives.js";

export const OPENCLAW_HARNESS_ADAPTER_ID = "openclaw-harness-runtime.v1";

/**
 * Creates the first concrete HarnessRuntime adapter for OpenClaw controller/plugin runtimes.
 * The controller is optional so local composition can fail closed when OpenClaw live execution is unavailable.
 */
export function createOpenClawHarnessAdapter({ controller = null, adapterId = OPENCLAW_HARNESS_ADAPTER_ID } = {}) {
  return {
    adapter_id: adapterId,
    adapter: adapterId,
    externalSideEffects: true,
    capabilities() {
      return {
        adapter_id: adapterId,
        side_effect_class: "local_harness_session",
        supports_spawn: Boolean(controller && typeof controller.spawn === "function"),
        supports_reattach: Boolean(controller && typeof controller.reattach === "function"),
        supports_poll: Boolean(controller && typeof controller.poll === "function"),
        supports_cancel: Boolean(controller && typeof controller.cancel === "function"),
        heartbeat: "summary_only",
      };
    },
    async spawn(envelope, options = {}) {
      if (!controller || typeof controller.spawn !== "function") {
        return {
          status: "BLOCKED",
          adapter: adapterId,
          actor: adapterId,
          problem: {
            code: "openclaw_harness_unavailable",
            message: "OpenClaw harness controller is not configured for this runner invocation.",
          },
        };
      }
      const result = await controller.spawn(envelope, options);
      return { adapter: adapterId, actor: adapterId, ...result };
    },
    async reattach(adapterTaskId, options = {}) {
      if (!controller || typeof controller.reattach !== "function") {
        return { status: "UNKNOWN", adapter: adapterId, actor: adapterId, adapter_task_id: nonEmptyString(adapterTaskId) };
      }
      const result = await controller.reattach(adapterTaskId, options);
      return { adapter: adapterId, actor: adapterId, ...result };
    },
    async poll(adapterTaskId, options = {}) {
      if (!controller || typeof controller.poll !== "function") {
        return { status: "UNKNOWN", adapter: adapterId, actor: adapterId, adapter_task_id: nonEmptyString(adapterTaskId) };
      }
      const result = await controller.poll(adapterTaskId, options);
      return { adapter: adapterId, actor: adapterId, ...result };
    },
  };
}
