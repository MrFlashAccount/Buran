#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const skippedDirNames = new Set([".git", "node_modules"]);
const ignoredRuntimeRootDirs = new Set(["registry", ".openclaw-runtime", "artifacts", "logs"]);
const documentedPathFiles = ["docs/module-map.md"];
const documentedPathPrefixes = ["bin/", "docs/", "scripts/", "src/", "test/"];
const documentedRootFiles = new Set(["index.js", "package.json"]);
const oldTopLevelModules = new Set([
  "buran.js",
  "cli.js",
  "constants.js",
  "execution-run-schema.js",
  "fs-atomic.js",
  "github-pr-transport-adapter.js",
  "implementation-dispatch.js",
  "internal-review-adapter.js",
  "locks.js",
  "observability.js",
  "packet-sufficiency.js",
  "pr-projection-adapter.js",
  "projection-contract.js",
  "recovery.js",
  "registry-store.js",
  "registry.js",
  "runner.js",
  "state-machine.js",
  "utils.js",
  "verification-adapter.js",
  "workflow-policy.js",
  "workspace-preparation.js",
]);
const domainVocabulary = /\b(buran|packet|registry|run|runs|gate|github|projection|workflow|lease|state-machine|implementation-dispatch)\b/i;
const oldExecutionRunAuthorityModules = new Set([
  "src/execution-runs/constants.js",
  "src/execution-runs/state-machine.js",
]);
const coreProviderVocabulary = /GitHub|Github|github-pr/;
const coreProviderCompatibilityFiles = new Set([
  "src/core/modules/scm-handoff/value-objects/github-pr-handoff-target.js",
]);

function shouldSkipDirectory(parentDir, entryName) {
  if (skippedDirNames.has(entryName)) return true;
  return parentDir === root && ignoredRuntimeRootDirs.has(entryName);
}

async function listFiles(dir, predicate = () => true) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && shouldSkipDirectory(dir, entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, predicate));
    else if (predicate(full)) files.push(full);
  }
  return files;
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function importSpecs(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return spec;
  return rel(path.resolve(path.dirname(fromFile), spec));
}

function normalizeDocumentedRepoPath(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

function isDocumentedRepoPath(value) {
  return documentedRootFiles.has(value) || documentedPathPrefixes.some((prefix) => value.startsWith(prefix));
}

async function documentedPathExists(repoPath) {
  const stat = await fs.stat(path.join(root, repoPath)).catch(() => null);
  if (!stat) return false;
  return !repoPath.endsWith("/") || stat.isDirectory();
}

async function validateDocumentedRepoPaths() {
  for (const fileRel of documentedPathFiles) {
    const source = await fs.readFile(path.join(root, fileRel), "utf8").catch(() => "");
    const pathPattern = /`([^`\n]+)`/g;
    let match;
    while ((match = pathPattern.exec(source))) {
      const repoPath = normalizeDocumentedRepoPath(match[1]);
      if (!isDocumentedRepoPath(repoPath)) continue;
      if (!await documentedPathExists(repoPath)) failures.push(`${fileRel} references missing repo path ${repoPath}`);
    }
  }
}

await validateDocumentedRepoPaths();

const srcTop = await fs.readdir(path.join(root, "src"), { withFileTypes: true });
for (const entry of srcTop) {
  if (entry.isFile() && entry.name.endsWith(".js")) failures.push(`top-level src shim/file is not allowed: src/${entry.name}`);
}

const jsFiles = await listFiles(root, (file) => file.endsWith(".js"));
for (const file of jsFiles) {
  const fileRel = rel(file);
  const source = await fs.readFile(file, "utf8");
  for (const spec of importSpecs(source)) {
    const resolved = resolveSpec(file, spec);
    if (resolved.startsWith("src/") && resolved.split("/").length === 2 && oldTopLevelModules.has(path.basename(resolved))) {
      failures.push(`${fileRel} imports old flat src module ${resolved}`);
    }
    if (oldExecutionRunAuthorityModules.has(resolved) && fileRel !== resolved && /^src\//.test(fileRel)) {
      failures.push(`${fileRel} imports deprecated execution-run authority module ${resolved}; use src/core/modules/execution-runs`);
    }
    if (/^src\/core\//.test(fileRel)) {
      if (/^src\/(application|composition|entrypoints|integrations)\//.test(resolved)) {
        failures.push(`${fileRel} imports outside core boundary ${resolved}`);
      }
    }
    if (/^src\/(application|approved-packets|execution-runs|gates|stack-workflow|workflow-boundary|observability|workspace-leases|shared)\//.test(fileRel)) {
      if (/^src\/integrations\//.test(resolved)) {
        failures.push(`${fileRel} imports concrete integration ${resolved}`);
      }
    }
    if (/^src\/integrations\//.test(fileRel)) {
      if (/^src\/(application|entrypoints|composition)\//.test(resolved)) {
        failures.push(`${fileRel} imports orchestration/application layer ${resolved}`);
      }
    }
    if (/^src\/(core\/modules\/scm-handoff|workflow-boundary\/scm-handoff)\//.test(fileRel) && /^src\/integrations\/scm\/github\//.test(resolved)) {
      failures.push(`${fileRel} imports GitHub integration from provider-neutral SCM handoff boundary ${resolved}`);
    }
    if (/^src\/integrations\//.test(fileRel) && !/^src\/integrations\/storage\/json-registry\//.test(fileRel)) {
      if (/^src\/integrations\/storage\/json-registry\/store\.js$/.test(resolved)) {
        failures.push(`${fileRel} imports JSON registry store internals ${resolved}`);
      }
      if (/^src\/integrations\/storage\/json-registry\/(atomic-read-write|event-journal|fs-atomic|indexes-snapshots|lease-records|path-layout)\.js$/.test(resolved)) {
        const combinedAdapter = /(^|\/)combined-|(^|\/)composition-|(^|\/)json-registry-worktree-/.test(fileRel);
        if (!combinedAdapter) failures.push(`${fileRel} imports JSON registry storage internals ${resolved}`);
      }
    }
  }
}

const coreModuleFiles = await listFiles(path.join(root, "src", "core", "modules"), (file) => file.endsWith(".js") || file.endsWith(".md"));
for (const file of coreModuleFiles) {
  const fileRel = rel(file);
  if (coreProviderCompatibilityFiles.has(fileRel)) continue;
  const source = await fs.readFile(file, "utf8");
  if (coreProviderVocabulary.test(source)) failures.push(`${fileRel} contains provider-specific GitHub vocabulary in canonical core`);
}

const sharedFiles = await listFiles(path.join(root, "src", "shared"), (file) => file.endsWith(".js"));
for (const file of sharedFiles) {
  const source = await fs.readFile(file, "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (domainVocabulary.test(withoutComments)) failures.push(`${rel(file)} contains Buran domain vocabulary; keep shared generic`);
}

if (failures.length) {
  console.error("Boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("boundary check passed");
