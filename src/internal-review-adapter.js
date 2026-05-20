/**
 * Local internal-review adapter for recording manual-review requirements from an approved packet.
 *
 * Responsibility:
 * - parse review criteria from the immutable packet artifact,
 * - emit a sanitized internal-review artifact for the gate ledger,
 * - block until explicit manual review evidence exists.
 *
 * Non-goals:
 * - no automated PASS/FAIL derivation from packet prose,
 * - no review resolution without an acquired workspace lease.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizePacket } from "./packet-sufficiency.js";
import { sanitizePublicReportForOutput } from "./observability.js";
import { isRecord, nonEmptyString, sha256Hex } from "./utils.js";

const INTERNAL_REVIEW_ADAPTER_ID = "local-internal-review-allowlist.v1";
const REVIEW_VERDICT_SCHEMA_VERSION = "internal-review-verdict.v1";
const INTERNAL_REVIEW_ACTOR = "local-internal-review-adapter";
const PACKET_FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/i;
const REVIEW_VERDICT_STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const REVIEW_VERDICT_PRIVATE_KEYS = new Set(["prompt", "transcript", "stdout", "stderr", "output", "log", "logs", "session"]);

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

function buildPathContexts(workspacePath) {
  const contexts = [];
  const resolvedWorkspacePath = nonEmptyString(workspacePath);
  if (resolvedWorkspacePath) contexts.push({ root: resolvedWorkspacePath, label: "<workspace>" });
  return contexts;
}

function sanitizeValue(value, contexts) {
  return sanitizePublicReportForOutput(value, contexts);
}

function isPrivateReviewVerdictKey(key) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  const compact = normalized.replace(/_/g, "");
  if (["prompt", "transcript", "stdout", "stderr", "output", "session"].some((token) => compact.includes(token))) return true;
  return normalized.split("_").some((part) => REVIEW_VERDICT_PRIVATE_KEYS.has(part) || part.startsWith("log"));
}

function sanitizeReviewVerdictValue(value, contexts, { depth = 0 } = {}) {
  if (depth > 8) return "[REDACTED_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return sanitizeValue(value, contexts);
  if (Array.isArray(value)) return value.map((entry) => sanitizeReviewVerdictValue(entry, contexts, { depth: depth + 1 }));
  if (!isRecord(value)) return sanitizeValue(String(value), contexts);

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPrivateReviewVerdictKey(key)) continue;
    output[key] = sanitizeReviewVerdictValue(entry, contexts, { depth: depth + 1 });
  }
  return output;
}

function sanitizeReviewVerdictPayload(parsed, status, schemaVersion, artifactRef, contexts) {
  return sanitizeReviewVerdictValue({
    artifact_ref: artifactRef,
    schema_version: schemaVersion || REVIEW_VERDICT_SCHEMA_VERSION,
    status,
    reviewer: nonEmptyString(parsed.reviewer || parsed.actor || "independent-reviewer"),
    summary: nonEmptyString(parsed.summary),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    problem: isRecord(parsed.problem) ? parsed.problem : null,
  }, contexts);
}

function resolveReviewVerdictPath(runDir, artifactPath) {
  const input = nonEmptyString(artifactPath);
  if (!input) return null;
  if (path.isAbsolute(input)) {
    const error = new Error("Independent review verdict artifact path must be relative to the run directory.");
    error.code = "review_artifact_path_invalid";
    throw error;
  }
  const absolutePath = path.resolve(runDir, path.normalize(input));
  const relativePath = path.relative(runDir, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    const error = new Error("Independent review verdict artifact path escapes the run directory.");
    error.code = "review_artifact_path_invalid";
    throw error;
  }
  if (!(relativePath === "artifacts" || relativePath.startsWith(`artifacts${path.sep}`))) {
    const error = new Error("Independent review verdict artifact must be stored under artifacts/.");
    error.code = "review_artifact_path_invalid";
    throw error;
  }
  return { absolutePath, relativePath };
}

async function loadReviewVerdictArtifact(runDir, artifactPath, contexts) {
  const resolved = resolveReviewVerdictPath(runDir, artifactPath);
  if (!resolved) return null;
  try {
    const content = await fs.readFile(resolved.absolutePath, "utf8");
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      const error = new Error("Independent review verdict artifact must contain a JSON object.");
      error.code = "review_artifact_invalid";
      throw error;
    }
    const status = nonEmptyString(parsed.status).toUpperCase();
    if (!REVIEW_VERDICT_STATUSES.has(status)) {
      const error = new Error("Independent review verdict artifact status must be PASS, FAIL, or BLOCKED.");
      error.code = "review_artifact_invalid";
      throw error;
    }
    const schemaVersion = nonEmptyString(parsed.schema_version || parsed.schemaVersion);
    if (schemaVersion && schemaVersion !== REVIEW_VERDICT_SCHEMA_VERSION) {
      const error = new Error(`Independent review verdict artifact schema_version must be ${REVIEW_VERDICT_SCHEMA_VERSION}.`);
      error.code = "review_artifact_invalid";
      throw error;
    }
    return sanitizeReviewVerdictPayload(parsed, status, schemaVersion, {
      path: resolved.relativePath,
      sha256: sha256Hex(content),
    }, contexts);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error("Independent review verdict artifact is missing.");
      missing.code = "review_artifact_missing";
      throw missing;
    }
    if (error instanceof SyntaxError) {
      const invalid = new Error("Independent review verdict artifact is not valid JSON.");
      invalid.code = "review_artifact_invalid";
      throw invalid;
    }
    throw error;
  }
}

/**
 * Extracts the internal-review contract from the normalized approved packet.
 *
 * @param {object} packet Parsed approved packet JSON.
 * @param {object} snapshot Current run snapshot used for normalization context.
 * @returns {{criteria: string[], reviewer_plan: string}} Review criteria and reviewer plan expected by the manual gate.
 */
function normalizeReviewPacket(packet, snapshot) {
  const normalized = normalizePacket(packet, {
    sourcePath: snapshot?.packet?.source_path || "",
  });
  const rawReview = isRecord(packet?.review) ? packet.review : {};
  return {
    criteria: Array.isArray(normalized.review?.criteria) ? normalized.review.criteria : [],
    reviewer_plan: normalized.review?.reviewer_plan || "",
    verdict_artifact_path: nonEmptyString(
      rawReview.verdict_artifact_path
        || rawReview.verdictArtifactPath
        || rawReview.result_artifact_path
        || rawReview.resultArtifactPath
        || packet?.review_verdict_artifact_path
        || packet?.reviewVerdictArtifactPath,
    ),
  };
}

function buildArtifactPayload({
  runId,
  executionEpoch,
  gateAttempt,
  workspaceId,
  review,
  status,
  summary,
  problem = null,
  startedAt,
  finishedAt,
  contexts,
} = {}) {
  return sanitizeValue({
    schema_version: "internal-review-report.v1",
    adapter: INTERNAL_REVIEW_ADAPTER_ID,
    run_id: runId,
    gate_name: "internal_review",
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    workspace_id: workspaceId || "",
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    summary,
    packet_review: {
      criteria: review.criteria,
      reviewer_plan: review.reviewer_plan || "",
      verdict_artifact_path: review.verdict_artifact_path || "",
    },
    reviewer_result: review.reviewer_result || null,
    problem,
  }, contexts);
}

function resultSummary(status, problem = null, reviewerResult = null) {
  if (problem?.code) return problem.message;
  const summary = nonEmptyString(reviewerResult?.summary);
  if (status === "PASS") return summary || "Internal review passed from independent reviewer artifact.";
  if (status === "FAIL") return summary || "Internal review failed inside approved scope from independent reviewer artifact.";
  return summary || "Internal review blocked from independent reviewer artifact.";
}

/**
 * Produces a blocked internal-review gate artifact until manual review evidence is supplied.
 *
 * @param {object} params
 * @param {string} params.runDir Absolute run directory containing immutable packet artifacts.
 * @param {object} params.snapshot Current run snapshot used to load packet review criteria and lease context.
 * @param {() => Date} [params.clock=() => new Date()] Clock source used for started/finished timestamps.
 * @returns {Promise<object>} Internal-review gate result ready for artifact recording in the registry ledger.
 * @throws {Error} When the caller omits required run context.
 */
export async function executeInternalReviewGate({ runDir, snapshot, clock = () => new Date() } = {}) {
  if (!runDir) throw new Error("runDir is required for internal review execution");
  if (!snapshot?.run_id) throw new Error("run snapshot is required for internal review execution");

  const workspacePath = nonEmptyString(snapshot.workspace?.path);
  const contexts = buildPathContexts(workspacePath);
  const executionEpoch = snapshot.execution?.current_epoch || 0;
  const gateAttempt = (snapshot.gates?.internal_review?.current_attempt || 0) + 1;
  const startedAt = clock().toISOString();

  let review;
  try {
    review = normalizeReviewPacket(await loadApprovedPacket(runDir, snapshot), snapshot);
  } catch (error) {
    const problem = sanitizeValue({
      code: "packet_artifact_invalid",
      message: nonEmptyString(error?.message) || "Approved packet artifact could not be parsed for internal review.",
    }, contexts);
    const finishedAt = clock().toISOString();
    const artifactPayload = buildArtifactPayload({
      runId: snapshot.run_id,
      executionEpoch,
      gateAttempt,
      workspaceId: snapshot.workspace?.id || "",
      review: { criteria: [], reviewer_plan: "", verdict_artifact_path: "", reviewer_result: null },
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
      adapter: INTERNAL_REVIEW_ADAPTER_ID,
      actor: INTERNAL_REVIEW_ACTOR,
      status: "BLOCKED",
      execution_epoch: executionEpoch,
      gate_attempt: gateAttempt,
      recorded_at: finishedAt,
      idempotency_key: `${snapshot.run_id}:internal_review:${executionEpoch}:${gateAttempt}:${artifactHash.slice(0, 16)}`,
      artifact_path: `artifacts/internal-review/${artifactHash.slice(0, 16)}.json`,
      artifact_content: artifactContent,
      public_report: artifactPayload,
      provenance: { kind: "internal-review-report", adapter: INTERNAL_REVIEW_ADAPTER_ID },
    };
  }

  let reviewerResult = null;
  let blockedProblem = snapshot.workspace?.lease_status !== "acquired"
    ? { code: "workspace_lease_required", message: "Internal review requires an active acquired workspace lease." }
    : review.criteria.length === 0 && !review.reviewer_plan
      ? { code: "unsupported_review_shape", message: "Internal review requires review.criteria or review.reviewer_plan in the approved packet." }
      : !review.verdict_artifact_path
        ? {
            code: "independent_internal_review_required",
            message: "Internal review requires an independent reviewer verdict artifact; packet text cannot self-approve.",
          }
        : null;

  if (!blockedProblem) {
    try {
      reviewerResult = await loadReviewVerdictArtifact(runDir, review.verdict_artifact_path, contexts);
    } catch (error) {
      blockedProblem = {
        code: error?.code || "review_artifact_invalid",
        message: nonEmptyString(error?.message) || "Independent review verdict artifact could not be loaded.",
      };
    }
  }

  const status = blockedProblem ? "BLOCKED" : reviewerResult.status;
  const problem = blockedProblem
    ? sanitizeValue(blockedProblem, contexts)
    : status === "BLOCKED"
      ? sanitizeValue(reviewerResult.problem || {
          code: "independent_review_blocked",
          message: reviewerResult.summary || "Independent review artifact returned BLOCKED.",
        }, contexts)
      : null;
  review = {
    ...review,
    reviewer_result: reviewerResult,
  };
  const finishedAt = clock().toISOString();
  const summary = resultSummary(status, problem, reviewerResult);
  const artifactPayload = buildArtifactPayload({
    runId: snapshot.run_id,
    executionEpoch,
    gateAttempt,
    workspaceId: snapshot.workspace?.id || "",
    review,
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
    adapter: INTERNAL_REVIEW_ADAPTER_ID,
    actor: INTERNAL_REVIEW_ACTOR,
    status,
    execution_epoch: executionEpoch,
    gate_attempt: gateAttempt,
    recorded_at: finishedAt,
    idempotency_key: `${snapshot.run_id}:internal_review:${executionEpoch}:${gateAttempt}:${artifactHash.slice(0, 16)}`,
    artifact_path: `artifacts/internal-review/${artifactHash.slice(0, 16)}.json`,
    artifact_content: artifactContent,
    public_report: artifactPayload,
    provenance: {
      kind: "internal-review-report",
      adapter: INTERNAL_REVIEW_ADAPTER_ID,
      criteria_count: review.criteria.length,
      reviewer_plan_present: Boolean(review.reviewer_plan),
      verdict_artifact_present: Boolean(review.verdict_artifact_path),
      reviewer_result_present: Boolean(reviewerResult),
    },
  };
}
