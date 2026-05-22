import path from "node:path";

import { nonEmptyString } from "./primitives.js";

/**
 * Returns true only for non-empty, relative paths that cannot escape a caller-owned root.
 * Rejects POSIX absolute paths, Windows absolute paths, and any raw or normalized `..` segment.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeContainedRelativePath(value) {
  const input = nonEmptyString(value);
  if (!input || path.isAbsolute(input) || path.win32.isAbsolute(input)) return false;

  const rawSegments = input.split(/[\\/]+/);
  if (rawSegments.includes("..")) return false;

  const normalized = path.normalize(input);
  if (!normalized || normalized === "." || path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return false;
  return !normalized.split(/[\\/]+/).includes("..");
}

/**
 * Resolves a safe relative path under a root and returns null when the candidate is unsafe.
 *
 * @param {string} rootDir
 * @param {unknown} value
 * @returns {{absolutePath: string, relativePath: string}|null}
 */
export function resolveContainedRelativePath(rootDir, value) {
  const root = path.resolve(nonEmptyString(rootDir));
  const input = nonEmptyString(value);
  if (!root || !isSafeContainedRelativePath(input)) return null;

  const absolutePath = path.resolve(root, path.normalize(input));
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath };
}
