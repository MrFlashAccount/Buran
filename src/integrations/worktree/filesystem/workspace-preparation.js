import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { canonicalJson, nonEmptyString, sha256Hex } from "../../../shared/primitives.js";

const execFileAsync = promisify(execFile);

function buildIssue(code, message, extra = {}) {
  return { code, message, ...extra };
}

async function runGit(workspacePath, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", ["-C", workspacePath, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: String(result.stdout || "").trimEnd(),
      stderr: String(result.stderr || "").trimEnd(),
      code: 0,
    };
  } catch (error) {
    if (allowFailure && typeof error?.code === "number") {
      return {
        ok: false,
        stdout: String(error.stdout || "").trimEnd(),
        stderr: String(error.stderr || "").trimEnd(),
        code: error.code,
        error,
      };
    }
    throw error;
  }
}

function parseBranchHeader(headerLine) {
  const header = String(headerLine || "").trim();
  const result = {
    raw: header,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
  };
  if (!header.startsWith("## ")) return result;

  if (header.startsWith("## No commits yet on ")) {
    result.branch = header.slice("## No commits yet on ".length).trim() || null;
    result.unborn = true;
    return result;
  }

  const subject = header.slice(3).trim();
  if (!subject || subject.startsWith("HEAD (")) {
    result.detached = true;
    return result;
  }

  const [branchPart, trackingPart = ""] = subject.split("...", 2);
  result.branch = branchPart.trim() || null;
  const trackingMatch = trackingPart.match(/^([^\[]+)?(?:\s+\[(.*)\])?$/);
  if (trackingMatch) {
    result.upstream = trackingMatch[1]?.trim() || null;
    const details = trackingMatch[2] || "";
    const aheadMatch = details.match(/ahead (\d+)/);
    const behindMatch = details.match(/behind (\d+)/);
    result.ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
    result.behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
  }
  return result;
}

function parseStatusEntries(statusText) {
  const lines = String(statusText || "").split(/\r?\n/).filter(Boolean);
  const branch = parseBranchHeader(lines[0] || "");
  const entries = [];
  const summary = {
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    total: 0,
  };

  for (const line of lines.slice(1)) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const payload = line.slice(3);
    const renameParts = payload.includes(" -> ") ? payload.split(" -> ") : [payload];
    const entry = {
      code,
      path: renameParts.at(-1) || payload,
    };
    if (renameParts.length > 1) entry.previous_path = renameParts[0];
    entries.push(entry);

    if (code === "??") summary.untracked += 1;
    if (code.includes("U") || code === "AA" || code === "DD") summary.conflicted += 1;
    if (code[0] && code[0] !== " " && code[0] !== "?") summary.staged += 1;
    if (code[1] && code[1] !== " " && code[1] !== "?") summary.unstaged += 1;
  }

  summary.total = entries.length;
  summary.dirty = summary.total > 0;
  return { branch, entries, summary };
}

async function hashFileContent(filePath) {
  const content = await fs.readFile(filePath);
  return sha256Hex(content);
}

async function fingerprintPath(absolutePath, { rootPath, relativePath } = {}) {
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: relativePath,
        exists: false,
        kind: "missing",
        fingerprint_sha256: "",
      };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath);
    return {
      path: relativePath,
      exists: true,
      kind: "symlink",
      fingerprint_sha256: sha256Hex(target),
      bytes: Buffer.byteLength(target),
    };
  }

  if (stat.isFile()) {
    return {
      path: relativePath,
      exists: true,
      kind: "file",
      bytes: stat.size,
      fingerprint_sha256: await hashFileContent(absolutePath),
    };
  }

  if (stat.isDirectory()) {
    const children = await fs.readdir(absolutePath, { withFileTypes: true });
    const nested = [];
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === ".git") continue;
      const childRelativePath = path.join(relativePath, child.name);
      nested.push(await fingerprintPath(path.join(absolutePath, child.name), {
        rootPath,
        relativePath: childRelativePath,
      }));
    }
    return {
      path: relativePath,
      exists: true,
      kind: "directory",
      entry_count: nested.length,
      fingerprint_sha256: sha256Hex(canonicalJson(nested)),
    };
  }

  return {
    path: relativePath,
    exists: true,
    kind: "other",
    fingerprint_sha256: sha256Hex(`${stat.mode}:${stat.size}`),
  };
}

async function buildEntryFingerprints(repoRoot, entries) {
  const fingerprints = [];
  for (const entry of entries) {
    const absolutePath = path.resolve(repoRoot, entry.path);
    const relativeCheck = path.relative(repoRoot, absolutePath);
    if (!relativeCheck || relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
      fingerprints.push({
        path: entry.path,
        exists: false,
        kind: "outside_repo",
        fingerprint_sha256: "",
      });
      continue;
    }
    fingerprints.push(await fingerprintPath(absolutePath, { rootPath: repoRoot, relativePath: entry.path }));
  }
  return fingerprints;
}

function workspaceStatusWarnings(report) {
  const warnings = [];
  if (report.git.status.dirty) {
    warnings.push(buildIssue("workspace_dirty", "Workspace has local changes or untracked files.", {
      dirty_entries: report.git.status.total,
    }));
  }
  if (report.intended_branch && report.git.branch && report.intended_branch !== report.git.branch) {
    warnings.push(buildIssue("workspace_branch_mismatch", `Workspace branch ${report.git.branch} does not match intended branch ${report.intended_branch}.`, {
      intended_branch: report.intended_branch,
      observed_branch: report.git.branch,
    }));
  }
  if (!report.git.branch) {
    warnings.push(buildIssue("workspace_branch_unresolved", "Workspace branch could not be resolved cleanly from local git state."));
  }
  if (!report.git.head_sha) {
    warnings.push(buildIssue("workspace_head_unborn", "Workspace has no local commit at HEAD yet."));
  }
  return warnings;
}

export async function inspectWorkspacePreparation(workspacePath, { intendedBranch = "" } = {}) {
  const resolvedWorkspacePath = nonEmptyString(workspacePath);
  if (!resolvedWorkspacePath) {
    return {
      ok: false,
      blocker: buildIssue("workspace_path_required", "Running mission needs a local workspace path before workspace preparation can be recorded."),
      warnings: [],
    };
  }

  const absoluteWorkspacePath = path.resolve(resolvedWorkspacePath);
  let stat;
  try {
    stat = await fs.stat(absoluteWorkspacePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        blocker: buildIssue("workspace_path_missing", `Workspace path ${absoluteWorkspacePath} does not exist locally.`),
        warnings: [],
      };
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      blocker: buildIssue("workspace_path_invalid", `Workspace path ${absoluteWorkspacePath} is not a directory.`),
      warnings: [],
    };
  }

  let insideWorkTree;
  try {
    insideWorkTree = await runGit(absoluteWorkspacePath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        blocker: buildIssue("git_required", "Local git is required for workspace preparation inspection."),
        warnings: [],
      };
    }
    throw error;
  }

  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== "true") {
    return {
      ok: false,
      blocker: buildIssue("workspace_not_git_repo", `Workspace path ${absoluteWorkspacePath} is not a local git worktree.`),
      warnings: [],
    };
  }

  const [showTopLevel, showGitDir, showCommonDir, statusResult, branchResult, headResult] = await Promise.all([
    runGit(absoluteWorkspacePath, ["rev-parse", "--show-toplevel"]),
    runGit(absoluteWorkspacePath, ["rev-parse", "--git-dir"]),
    runGit(absoluteWorkspacePath, ["rev-parse", "--git-common-dir"]),
    runGit(absoluteWorkspacePath, ["status", "--porcelain=v1", "--branch"]),
    runGit(absoluteWorkspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
    runGit(absoluteWorkspacePath, ["rev-parse", "HEAD"], { allowFailure: true }),
  ]);

  const repoRoot = path.resolve(absoluteWorkspacePath, showTopLevel.stdout.trim() || ".");
  const gitDir = path.resolve(absoluteWorkspacePath, showGitDir.stdout.trim() || ".git");
  const gitCommonDir = path.resolve(absoluteWorkspacePath, showCommonDir.stdout.trim() || ".git");
  const status = parseStatusEntries(statusResult.stdout);
  const entryFingerprints = await buildEntryFingerprints(repoRoot, status.entries);
  const branch = branchResult.ok ? nonEmptyString(branchResult.stdout) || status.branch.branch : status.branch.branch;
  const headSha = headResult.ok ? nonEmptyString(headResult.stdout) : "";
  const reportCore = {
    schema_version: "workspace-preparation.v1",
    workspace_path: absoluteWorkspacePath,
    repo_root: repoRoot,
    intended_branch: nonEmptyString(intendedBranch),
    git: {
      branch,
      head_sha: headSha || null,
      head_present: Boolean(headSha),
      git_dir: gitDir,
      git_common_dir: gitCommonDir,
      is_worktree: gitDir !== gitCommonDir,
      status_header: status.branch,
      status: status.summary,
      entries: status.entries.map((entry, index) => ({
        ...entry,
        fingerprint: entryFingerprints[index],
      })),
    },
  };
  const workspaceSnapshotId = sha256Hex(canonicalJson(reportCore));
  const report = {
    ...reportCore,
    workspace_snapshot_id: workspaceSnapshotId,
  };
  const warnings = workspaceStatusWarnings({
    intended_branch: report.intended_branch,
    git: report.git,
  });

  return {
    ok: true,
    preparation_status: warnings.length > 0 ? "warning" : "prepared",
    artifact_path: `artifacts/workspace-preparation/${workspaceSnapshotId.slice(0, 16)}.json`,
    content: `${JSON.stringify({ ...report, warnings }, null, 2)}\n`,
    report,
    warnings,
  };
}
