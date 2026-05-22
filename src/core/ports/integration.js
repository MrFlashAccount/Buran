/**
 * Integration descriptor validator used by composition/debug surfaces.
 *
 * Descriptors are metadata about concrete adapters; they are not domain entities,
 * inheritance bases, or lifecycle contracts. Concrete integrations still implement
 * their real core ports directly.
 */
import { nonEmptyString } from "../../shared/primitives.js";

/**
 * @typedef {object} IntegrationDescriptor
 * @property {string} name Stable integration identifier used in composition/debug output.
 * @property {string} kind Broad integration category, for example `storage`, `scm`, or `worktree`.
 * @property {string} boundary Human-readable statement of what local/external boundary this integration owns.
 * @property {string[]} [implementsPorts] Core ports or contracts implemented by this integration.
 * @property {boolean} [externalSideEffects=false] Whether normal execution can write outside the local registry/worktree.
 */

export function assertIntegrationDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") throw new Error("integration descriptor must be an object");
  if (!nonEmptyString(descriptor.name)) throw new Error("integration descriptor name is required");
  if (!nonEmptyString(descriptor.kind)) throw new Error("integration descriptor kind is required");
  if (!nonEmptyString(descriptor.boundary)) throw new Error("integration descriptor boundary is required");
  if (descriptor.implementsPorts !== undefined && !Array.isArray(descriptor.implementsPorts)) {
    throw new Error("integration descriptor implementsPorts must be an array when present");
  }
  return descriptor;
}

/**
 * Create a frozen integration descriptor without introducing a fake base class.
 *
 * @param {IntegrationDescriptor} descriptor Integration metadata.
 * @returns {Readonly<IntegrationDescriptor>} Frozen descriptor object.
 */
export function createIntegrationDescriptor(descriptor) {
  const checked = assertIntegrationDescriptor(descriptor);
  return Object.freeze({
    ...checked,
    implementsPorts: Object.freeze([...(checked.implementsPorts || [])]),
    externalSideEffects: Boolean(checked.externalSideEffects),
  });
}
