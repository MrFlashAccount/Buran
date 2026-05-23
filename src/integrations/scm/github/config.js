import { isRecord, nonEmptyString } from "../../../shared/primitives.js";

export const DEFAULT_GITHUB_HOST = "github.com";
export const DEFAULT_GH_TIMEOUT_MS = 30_000;

export function normalizeGithubHost(host) {
  const rawHost = nonEmptyString(host) || DEFAULT_GITHUB_HOST;
  try {
    return new URL(rawHost.includes("://") ? rawHost : `https://${rawHost}`).host.toLowerCase();
  } catch {
    return rawHost.toLowerCase();
  }
}

export function normalizeAllowedRepos(allowedRepos = []) {
  return new Set((Array.isArray(allowedRepos) ? allowedRepos : []).map(nonEmptyString).filter(Boolean));
}

export function buildGithubCliEnv(sourceEnv = {}, extraEnv = {}) {
  const allowedKeys = [
    "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "NO_COLOR", "CI",
  ];
  const result = {};
  const source = isRecord(sourceEnv) ? sourceEnv : {};
  for (const key of allowedKeys) {
    const value = nonEmptyString(source[key]);
    if (value) result[key] = value;
  }
  result.GH_PROMPT_DISABLED = "1";
  result.GIT_TERMINAL_PROMPT = "0";
  const optIn = isRecord(extraEnv) ? extraEnv : {};
  for (const [key, value] of Object.entries(optIn)) {
    const normalizedKey = nonEmptyString(key);
    const normalizedValue = nonEmptyString(value);
    if (normalizedKey && normalizedValue) result[normalizedKey] = normalizedValue;
  }
  return result;
}
