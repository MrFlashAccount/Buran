#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const skippedDirNames = new Set([".git", ".worktrees", "node_modules"]);
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
  "scm-handoff-projection-adapter.js",
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
const removedCompatibilityModules = new Set([
  "src/application/workspace-preparation-inspector.js",
  "src/integrations/integration.js",
  "src/core/modules/scm-handoff/value-objects/github-pr-handoff-target.js",
  "src/execution-runs/constants.js",
  "src/execution-runs/registry/index.js",
  "src/execution-runs/state-machine.js",
  "src/integrations/scm/github/pr-transport-adapter.js",
  "src/workflow-boundary/pr-scm-projection/contract.js",
  "src/workflow-boundary/pr-scm-projection/local-journal-adapter.js",
  "src/workflow-boundary/scm-handoff/contract.js",
  "src/workflow-boundary/scm-handoff/index.js",
  "src/workflow-boundary/scm-handoff/local-journal-adapter.js",
  "src/workflow-boundary/scm-handoff/port.js",
  "src/workspace-leases/contract.js",
  "src/workspace-leases/lease-record-store.js",
  "src/workspace-leases/service.js",
]);
const removedCompatibilityPathPrefixes = [
  "src/workflow-boundary/pr-scm-projection/",
  "src/workflow-boundary/scm-handoff/",
];
const forbiddenCompatibilitySourcePatterns = [
  "Compatibility re-export",
  "Compatibility wrapper",
  "deprecated re-export",
  "deprecated wrapper",
].map((text) => new RegExp(text));
const coreProviderVocabulary = /GitHub|Github|github-pr/;
const staleHandoffVocabulary = /\b(pr_ready|runPrReadyStage|pr_projection)\b|github\.pr|projections\.github_pr/;
const staleScmHandoffArtifactPathPatterns = [
  /artifacts\/(pr|handoff)\//,
  /handoff\/projection-(intent|result)-/,
];
const providerSpecificPullRequestKindPattern = /kind:\s*["']pull_request["']/;
const coreModuleSubstanceDirs = new Set(["entities", "value-objects", "policies", "services"]);
const shallowCoreModuleAllowlist = new Map();

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


function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function importedLocalNames(importClause) {
  const names = [];
  const clause = importClause.trim();
  if (!clause || clause.startsWith("type ")) return names;
  const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) names.push(namespaceMatch[1]);
  const namedMatch = clause.match(/\{([\s\S]*)\}/);
  if (namedMatch) {
    for (const rawEntry of namedMatch[1].split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const aliasMatch = entry.match(/(?:^|\s)as\s+([A-Za-z_$][\w$]*)$/);
      const local = aliasMatch ? aliasMatch[1] : entry.match(/([A-Za-z_$][\w$]*)$/)?.[1];
      if (local) names.push(local);
    }
  }
  const defaultPart = clause.split(",")[0].trim();
  if (defaultPart && !defaultPart.startsWith("{") && !defaultPart.startsWith("*")) {
    const defaultName = defaultPart.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (defaultName) names.push(defaultName);
  }
  return names;
}

function validateImportedBindingsAreUsed(fileRel, source) {
  const importPattern = /^\s*import\s+([^;]*?)\s+from\s+["'][^"']+["'];/gm;
  const declarations = [...source.matchAll(importPattern)];
  if (!declarations.length) return;
  const body = stripJsComments(source.replace(importPattern, ""));
  for (const declaration of declarations) {
    for (const localName of importedLocalNames(declaration[1])) {
      if (!new RegExp(`\\b${localName.replace(/[$]/g, "\\$")}\\b`).test(body)) failures.push(`${fileRel} imports unused binding ${localName}`);
    }
  }
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

  const docFiles = await listFiles(path.join(root, "docs"), (file) => file.endsWith(".md"));
  for (const file of docFiles) {
    const fileRel = rel(file);
    const source = await fs.readFile(file, "utf8").catch(() => "");
    for (const removedPath of removedCompatibilityModules) {
      if (source.includes(removedPath)) failures.push(`${fileRel} references removed repo path ${removedPath}`);
    }
  }
}

async function hasJsFiles(dir) {
  const files = await listFiles(dir, (file) => file.endsWith(".js")).catch(() => []);
  return files.length > 0;
}

async function validateCoreModulesHaveSubstance() {
  const modulesRoot = path.join(root, "src", "core", "modules");
  const moduleEntries = await fs.readdir(modulesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of moduleEntries) {
    if (!entry.isDirectory()) continue;
    const moduleRel = `src/core/modules/${entry.name}`;
    const moduleDir = path.join(modulesRoot, entry.name);
    const childEntries = await fs.readdir(moduleDir, { withFileTypes: true }).catch(() => []);
    const hasPortFiles = await hasJsFiles(path.join(moduleDir, "ports"));
    const hasSubstance = await Promise.all(childEntries
      .filter((child) => child.isDirectory() && coreModuleSubstanceDirs.has(child.name))
      .map((child) => hasJsFiles(path.join(moduleDir, child.name))))
      .then((results) => results.some(Boolean));
    if (hasPortFiles && !hasSubstance && !shallowCoreModuleAllowlist.has(moduleRel)) {
      failures.push(`${moduleRel} is a shallow core module: ports exist but no entity, value object, policy, or service implementation`);
    }
  }
  for (const [moduleRel, reason] of shallowCoreModuleAllowlist) {
    if (!reason || !reason.trim()) failures.push(`${moduleRel} shallow core module allowlist entry is missing a documented reason`);
  }
}

await validateDocumentedRepoPaths();
await validateCoreModulesHaveSubstance();

for (const removedPath of removedCompatibilityModules) {
  if (await documentedPathExists(removedPath)) failures.push(`removed compatibility module still exists: ${removedPath}`);
}

const srcTop = await fs.readdir(path.join(root, "src"), { withFileTypes: true });
for (const entry of srcTop) {
  if (entry.isFile() && entry.name.endsWith(".js")) failures.push(`top-level src shim/file is not allowed: src/${entry.name}`);
}

const jsFiles = await listFiles(root, (file) => file.endsWith(".js"));
for (const file of jsFiles) {
  const fileRel = rel(file);
  const source = await fs.readFile(file, "utf8");
  validateImportedBindingsAreUsed(fileRel, source);
  for (const spec of importSpecs(source)) {
    const resolved = resolveSpec(file, spec);
    if (resolved.startsWith("src/") && resolved.split("/").length === 2 && oldTopLevelModules.has(path.basename(resolved))) {
      failures.push(`${fileRel} imports old flat src module ${resolved}`);
    }
    if (removedCompatibilityModules.has(resolved) || removedCompatibilityPathPrefixes.some((prefix) => resolved.startsWith(prefix))) {
      failures.push(`${fileRel} imports removed compatibility module ${resolved}; use canonical architecture paths`);
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
    if (fileRel === "src/application/operator-status.js" && (/^src\/integrations\/scm\//.test(resolved) || /^src\/execution-runs\/recovery\//.test(resolved) || /^src\/integrations\/implementation\//.test(resolved))) {
      failures.push(`${fileRel} imports forbidden action/remote/recovery dependency ${resolved}`);
    }
    if (/^src\/(core\/modules\/scm-handoff|workflow-boundary\/scm-handoff)\//.test(fileRel) && /^src\/integrations\/scm\/github\//.test(resolved)) {
      failures.push(`${fileRel} imports GitHub integration from provider-neutral SCM handoff boundary ${resolved}`);
    }
    if (/^src\/integrations\/scm\/github\//.test(fileRel) && /^src\/integrations\/scm\/local-journal\//.test(resolved)) {
      failures.push(`${fileRel} imports local-journal implementation ${resolved}; GitHub adapters must depend on core SCM handoff surfaces only`);
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

const providerNeutralCoreFiles = await listFiles(path.join(root, "src", "core"), (file) => file.endsWith(".js") || file.endsWith(".md"));
for (const file of providerNeutralCoreFiles) {
  const fileRel = rel(file);
  const source = await fs.readFile(file, "utf8");
  if (coreProviderVocabulary.test(source)) failures.push(`${fileRel} contains provider-specific GitHub vocabulary in canonical core`);
}

const sourceContractFiles = await listFiles(root, (file) => {
  const fileRel = rel(file);
  return (file.endsWith(".js") || file.endsWith(".md")) && /^(ARCHITECTURE\.md$|docs\/|src\/|test\/|scripts\/)/.test(fileRel) && fileRel !== "scripts/boundary-check.js";
});
for (const file of sourceContractFiles) {
  const fileRel = rel(file);
  const source = await fs.readFile(file, "utf8");
  for (const pattern of forbiddenCompatibilitySourcePatterns) {
    if (pattern.test(source)) failures.push(`${rel(file)} contains removed compatibility/deprecated-wrapper marker ${pattern}`);
  }
  if (staleHandoffVocabulary.test(source)) failures.push(`${rel(file)} contains stale PR-ready/projection vocabulary`);
  if (/^src\/(core\/modules\/execution-runs\/state-machine|execution-runs\/(recovery\/index|schema\/validators))\.js$/.test(fileRel) && /[\[({][^\n\]]*["']projected_local["'][^\n\]]*["']projected["'][^\n\]]*["']created["'][^\n\]]*["']updated["'][^\n\]]*[\])}]/.test(source)) {
    failures.push(`${fileRel} duplicates SCM handoff projection success statuses; use src/core/modules/scm-handoff/status.js`);
  }
  for (const pattern of staleScmHandoffArtifactPathPatterns) {
    if (pattern.test(source)) failures.push(`${rel(file)} contains stale SCM handoff artifact path ${pattern}`);
  }
  if (!fileRel.startsWith("src/integrations/scm/github/") && providerSpecificPullRequestKindPattern.test(source)) {
    failures.push(`${rel(file)} contains provider-specific pull_request target kind outside GitHub integration profile`);
  }
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
