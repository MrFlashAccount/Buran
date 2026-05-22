/** Shared safe reader for recorded run artifacts under a run directory. */
import { promises as fs } from "node:fs";
import { resolveContainedRelativePath } from "../shared/safe-relative-path.js";

/**
 * Resolve a recorded artifact path while rejecting absolute paths, traversal, and the run directory itself.
 *
 * @param {string} runDir Registry run directory.
 * @param {string} artifactPath Durable artifact path stored in the local registry.
 * @returns {{absolutePath: string, relativePath: string}|null}
 */
export function resolveRecordedArtifactPath(runDir, artifactPath) {
  return resolveContainedRelativePath(runDir, artifactPath);
}

/**
 * Read a JSON artifact only when its durable path is safely contained by the run directory.
 *
 * @param {string} runDir Registry run directory.
 * @param {{path?: string}|null} artifactRef Durable artifact reference.
 * @returns {Promise<object|null>} Parsed JSON object or null when missing/invalid/unsafe.
 */
export async function readRecordedArtifactJson(runDir, artifactRef) {
  const resolved = resolveRecordedArtifactPath(runDir, artifactRef?.path);
  if (!resolved) return null;
  try {
    const artifactText = await fs.readFile(resolved.absolutePath, "utf8");
    return JSON.parse(artifactText);
  } catch {
    return null;
  }
}
