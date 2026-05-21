/**
 * Minimal integration descriptor used to make adapter composition visible without
 * forcing every adapter into an inheritance hierarchy.
 *
 * Integrations are infrastructure-facing capabilities: they bind a core port or
 * composition surface to concrete IO such as filesystem storage, GitHub CLI, or
 * local process execution. The descriptor is intentionally metadata-only so
 * existing adapters can expose it where useful without changing behavior.
 */

/**
 * @typedef {object} IntegrationDescriptor
 * @property {string} name Stable integration identifier used in composition/debug output.
 * @property {string} kind Broad integration category, for example `storage`, `scm`, or `worktree`.
 * @property {string} boundary Human-readable statement of what external/local boundary this integration owns.
 * @property {string[]} [implementsPorts] Core ports or contracts implemented by this integration.
 * @property {boolean} [externalSideEffects=false] Whether normal execution can write outside the local registry/worktree.
 */

/**
 * Lightweight descriptor wrapper for concrete integrations.
 *
 * This class carries metadata only. It deliberately has no lifecycle hooks,
 * abstract methods, or required superclass relationship; adapters should keep
 * implementing the relevant core port contracts directly.
 */
export class Integration {
  /**
   * @param {IntegrationDescriptor} descriptor Integration metadata.
   */
  constructor(descriptor) {
    this.descriptor = Object.freeze({
      implementsPorts: [],
      externalSideEffects: false,
      ...descriptor,
    });
  }

  /** @returns {IntegrationDescriptor} Frozen metadata safe to expose from composition roots. */
  toDescriptor() {
    return this.descriptor;
  }
}

/**
 * Create a frozen integration descriptor.
 *
 * @param {IntegrationDescriptor} descriptor Integration metadata.
 * @returns {IntegrationDescriptor} Frozen descriptor object.
 */
export function createIntegrationDescriptor(descriptor) {
  return new Integration(descriptor).toDescriptor();
}
