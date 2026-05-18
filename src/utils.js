import crypto from "node:crypto";
import path from "node:path";

/**
 * Small shared pure helpers used across backend modules.
 *
 * Responsibilities:
 * - normalize lightweight string inputs;
 * - provide deterministic hashing/canonicalization helpers used by persistence contracts;
 * - resolve relative paths without touching the filesystem.
 *
 * Non-goals:
 * - schema validation;
 * - mutation of caller-owned values.
 */

/**
 * Returns true when a value is a plain object record.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Trims a string-like input and collapses empty values to an empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Normalizes a value into an array of non-empty strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => nonEmptyString(entry))
      .filter(Boolean);
  }

  const stringValue = nonEmptyString(value);
  return stringValue ? [stringValue] : [];
}

/**
 * Serializes JSON-like data with stable key ordering for hash and equality checks.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Computes a hexadecimal SHA-256 digest for a string or buffer payload.
 *
 * @param {string | Buffer} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Converts arbitrary input into a filesystem-safe identifier fragment.
 *
 * @param {unknown} value
 * @param {string} [fallback="task"]
 * @returns {string}
 */
export function safeIdPart(value, fallback = "task") {
  const normalized = nonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

/**
 * Resolves a maybe-relative path against a base directory.
 *
 * @param {string} baseDir
 * @param {unknown} value
 * @returns {string}
 */
export function resolveMaybeRelative(baseDir, value) {
  const input = nonEmptyString(value);
  if (!input) return "";
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input);
}
