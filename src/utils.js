import crypto from "node:crypto";
import path from "node:path";

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => nonEmptyString(entry))
      .filter(Boolean);
  }

  const stringValue = nonEmptyString(value);
  return stringValue ? [stringValue] : [];
}

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

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function safeIdPart(value, fallback = "task") {
  const normalized = nonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

export function resolveMaybeRelative(baseDir, value) {
  const input = nonEmptyString(value);
  if (!input) return "";
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input);
}
