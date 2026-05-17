import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { normalizePacket } from "./packet-sufficiency.js";
import { sanitizePublicReportForOutput } from "./observability.js";
import { nonEmptyString, sha256Hex } from "./utils.js";

const execFileAsync = promisify(execFile);

const VERIFICATION_ADAPTER_ID = "local-verification-allowlist.v1";
const VERIFICATION_ACTOR = "local-verification-adapter";
const COMMAND_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 8_000;
const PACKET_FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/i;
const COMMAND_SPECS = Object.freeze({
  "node --test test/runner.test.js": Object.freeze({ file: process.execPath, args: ["--test", "test/runner.test.js"] }),
  "node --test test/gate-ledger.test.js": Object.freeze({ file: process.execPath, args: ["--test", "test/gate-ledger.test.js"] }),
});
const SAFE_ENV_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function clipText(value, max = OUTPUT_LIMIT) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function packetArtifactPath(runDir, snapshot) {
  const relativePath = snapshot?.artifacts?.packet?.path;
  if (!nonEmptyString(relativePath)) throw new Error("run snapshot is missing artifacts.packet.path");
  return path.join(runDir, relativePath);
}

async function loadApprovedPacket(runDir, snapshot) {
  const artifactText = await fs.readFile(packetArtifactPath(runDir, snapshot), "utf8");
  const match = artifactText.match(PACKET_FENCE_PATTERN);
  if (!match?.[1]) throw new Error("approved packet artifact does not contain a JSON code fence");
  return JSON.parse(match[1]);
}

function normalizeVerificationPacket(packet, snapshot) {
  const normalized = normalizePacket(packet, {
    sourcePath: snapshot?.packet?.source_path || "",
  });
  return {
    expectations: normalized.verification?.expectations || "",
    commands: Array.isArray(normalized.verification?.commands) ? normalized.verification.commands : [],
  };
}

function commandSpec(command) {
  return COMMAND_SPECS[nonEmptyString(command)] || null;
}

function commandShapeProblem(command) {
  const normalized = nonEmptyString(command);
  if (/^npm\s+(?:test|run\s+check)$/i.test(normalized)) {
    return {
      code: "unsupported_verification_shape",
      message: "Verification commands must not delegate through package scripts; use the local direct-command allowlist only.",
    };
  }
  return {
    code: "unsupported_verification_shape",
    message: "Verification commands must use the local allowlist only.",
  };
}

function buildCommandEnv() {
  return SAFE_ENV_KEYS.reduce((environment, key) => {
    if (nonEmptyString(process.env[key])) environment[key] = process.env[key];
    return environment;
  }, {});
}

function buildPathContexts(workspacePath) {
  const contexts = [];
  const resolvedWorkspacePath = nonEmptyString(workspacePath);
  if (resolvedWorkspacePath) contexts.push({ root: resolvedWorkspacePath, label: "<workspace>" });
  return contexts;
}

function sanitizeValue(value, contexts) {
  return sanitizePublicReportForOutput(value, contexts);
}

function buildArtifactPayload({
  runId,
  executionEpoch,
  gateAttempt,
  workspaceId,
  verification,
  commandResults,
  status,
  summary,
  problem = null,
  startedAt,
  finishedAt,
  contexts,
} = {}) {
  return sanitizeValue({
    schema_version: "verification-report.v1",
    adapter: VERIFICATION_ADAPTER_ID,
    run_id: runId,
    gate_name: "verification",
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    workspace_id: workspaceId || "",
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    summary,
    packet_verification: {
      expectations: verification.expectations || "",
      commands: verification.commands,
    },
    command_results: commandResults,
    problem,
  }, contexts);
}

function resultSummary(commandResults, status, problem = null) {
  if (problem?.code) return problem.message;
  if (status === "PASS") return `Verification passed for ${commandResults.length} command${commandResults.length === 1 ? "" : "s"}.`;
  const firstFailure = commandResults.find((entry) => entry.status !== "PASS");
  if (!firstFailure) return `Verification finished with status ${status}.`;
  if (status === "FAIL") return `Verification failed on '${firstFailure.command}' with exit code ${firstFailure.exit_code}.`;
  return `Verification blocked on '${firstFailure.command}': ${firstFailure.reason || "unsupported verification adapter outcome"}.`;
}

async function executeAllowedCommand(command, workspacePath, contexts) {
  const spec = commandSpec(command);
  if (!spec) {
    return {
      command,
      adapter_command: null,
      status: "BLOCKED",
      exit_code: null,
      signal: "",
      duration_ms: 0,
      stdout: "",
      stderr: "",
      reason: `Unsupported verification command: ${command}`,
    };
  }

  const startedAtMs = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      cwd: workspacePath,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: buildCommandEnv(),
    });
    return sanitizeValue({
      command,
      adapter_command: [spec.file, ...spec.args].join(" "),
      status: "PASS",
      exit_code: 0,
      signal: "",
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      stdout: clipText(stdout),
      stderr: clipText(stderr),
      reason: "",
    }, contexts);
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const timedOut = error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT";
    const missingExecutable = error?.code === "ENOENT";
    const status = missingExecutable || timedOut ? "BLOCKED" : "FAIL";
    const reason = missingExecutable
      ? `Verification executable not found for command: ${command}`
      : timedOut
        ? `Verification command timed out after ${COMMAND_TIMEOUT_MS}ms: ${command}`
        : nonEmptyString(error?.message) || `Verification command failed: ${command}`;
    return sanitizeValue({
      command,
      adapter_command: [spec.file, ...spec.args].join(" "),
      status,
      exit_code: Number.isInteger(error?.code) ? error.code : error?.code === 0 ? 0 : error?.code && /^\d+$/.test(String(error.code)) ? Number.parseInt(String(error.code), 10) : error?.exitCode ?? null,
      signal: nonEmptyString(error?.signal),
      duration_ms: durationMs,
      stdout: clipText(error?.stdout || ""),
      stderr: clipText(error?.stderr || ""),
      reason,
    }, contexts);
  }
}

export async function executeVerificationGate({ runDir, snapshot, clock = () => new Date() } = {}) {
  if (!runDir) throw new Error("runDir is required for verification execution");
  if (!snapshot?.run_id) throw new Error("run snapshot is required for verification execution");

  const workspacePath = nonEmptyString(snapshot.workspace?.path);
  const contexts = buildPathContexts(workspacePath);
  const executionEpoch = snapshot.execution?.current_epoch || 0;
  const gateAttempt = (snapshot.gates?.verification?.current_attempt || 0) + 1;
  const startedAt = clock().toISOString();

  let verification;
  try {
    verification = normalizeVerificationPacket(await loadApprovedPacket(runDir, snapshot), snapshot);
  } catch (error) {
    const problem = sanitizeValue({
      code: "packet_artifact_invalid",
      message: nonEmptyString(error?.message) || "Approved packet artifact could not be parsed for verification.",
    }, contexts);
    const finishedAt = clock().toISOString();
    const artifactPayload = buildArtifactPayload({
      runId: snapshot.run_id,
      executionEpoch,
      gateAttempt,
      workspaceId: snapshot.workspace?.id || "",
      verification: { expectations: "", commands: [] },
      commandResults: [],
      status: "BLOCKED",
      summary: problem.message,
      problem,
      startedAt,
      finishedAt,
      contexts,
    });
    const artifactContent = `${JSON.stringify(artifactPayload, null, 2)}\n`;
    const artifactHash = sha256Hex(artifactContent);
    return {
      adapter: VERIFICATION_ADAPTER_ID,
      actor: VERIFICATION_ACTOR,
      status: "BLOCKED",
      execution_epoch: executionEpoch,
      gate_attempt: gateAttempt,
      recorded_at: finishedAt,
      idempotency_key: `${snapshot.run_id}:verification:${executionEpoch}:${gateAttempt}:${artifactHash.slice(0, 16)}`,
      artifact_path: `artifacts/verification/${artifactHash.slice(0, 16)}.json`,
      artifact_content: artifactContent,
      public_report: artifactPayload,
      provenance: { kind: "verification-report", adapter: VERIFICATION_ADAPTER_ID, command_count: 0 },
    };
  }

  const unsupportedCommand = verification.commands.find((command) => !commandSpec(command));
  const blockedProblem = !workspacePath
    ? { code: "workspace_path_required", message: "Verification requires an active leased workspace path." }
    : snapshot.workspace?.lease_status !== "acquired"
      ? { code: "workspace_lease_required", message: "Verification requires an active acquired workspace lease." }
      : verification.commands.length === 0
        ? { code: "unsupported_verification_shape", message: "Verification requires at least one allowlisted command; expectation-only verification is not executable locally." }
        : unsupportedCommand
          ? commandShapeProblem(unsupportedCommand)
          : null;

  const commandResults = [];
  let status = "PASS";
  let problem = blockedProblem ? sanitizeValue(blockedProblem, contexts) : null;

  if (!problem) {
    for (const command of verification.commands) {
      const result = await executeAllowedCommand(command, workspacePath, contexts);
      commandResults.push(result);
      if (result.status !== "PASS") {
        status = result.status;
        break;
      }
    }
  } else {
    status = "BLOCKED";
  }

  if (status === "PASS" && commandResults.some((entry) => entry.status !== "PASS")) {
    status = commandResults.find((entry) => entry.status !== "PASS")?.status || "FAIL";
  }
  if (status !== "PASS" && !problem && commandResults.length === 0) {
    problem = sanitizeValue({
      code: "verification_not_executed",
      message: "Verification did not execute any commands.",
    }, contexts);
  }

  const finishedAt = clock().toISOString();
  const summary = resultSummary(commandResults, status, problem);
  const artifactPayload = buildArtifactPayload({
    runId: snapshot.run_id,
    executionEpoch,
    gateAttempt,
    workspaceId: snapshot.workspace?.id || "",
    verification,
    commandResults,
    status,
    summary,
    problem,
    startedAt,
    finishedAt,
    contexts,
  });
  const artifactContent = `${JSON.stringify(artifactPayload, null, 2)}\n`;
  const artifactHash = sha256Hex(artifactContent);

  return {
    adapter: VERIFICATION_ADAPTER_ID,
    actor: VERIFICATION_ACTOR,
    status,
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    recorded_at: finishedAt,
    idempotency_key: `${snapshot.run_id}:verification:${executionEpoch}:${gateAttempt}:${artifactHash.slice(0, 16)}`,
    artifact_path: `artifacts/verification/${artifactHash.slice(0, 16)}.json`,
    artifact_content: artifactContent,
    public_report: artifactPayload,
    provenance: {
      kind: "verification-report",
      adapter: VERIFICATION_ADAPTER_ID,
      command_count: verification.commands.length,
      expectations_present: Boolean(verification.expectations),
    },
  };
}
