import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizePacket } from "./packet-sufficiency.js";
import { sanitizePublicReportForOutput } from "./observability.js";
import { nonEmptyString, sha256Hex } from "./utils.js";

const INTERNAL_REVIEW_ADAPTER_ID = "local-internal-review-allowlist.v1";
const INTERNAL_REVIEW_ACTOR = "local-internal-review-adapter";
const PACKET_FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/i;

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

function normalizeReviewPacket(packet, snapshot) {
  const normalized = normalizePacket(packet, {
    sourcePath: snapshot?.packet?.source_path || "",
  });
  return {
    criteria: Array.isArray(normalized.review?.criteria) ? normalized.review.criteria : [],
    reviewer_plan: normalized.review?.reviewer_plan || "",
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
    },
    problem,
  }, contexts);
}

function resultSummary(status, problem = null) {
  if (problem?.code) return problem.message;
  if (status === "PASS") return "Internal review passed.";
  if (status === "FAIL") return "Internal review failed inside approved scope.";
  return "Internal review blocked pending manual review evidence.";
}

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
      review: { criteria: [], reviewer_plan: "" },
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

  const blockedProblem = snapshot.workspace?.lease_status !== "acquired"
    ? { code: "workspace_lease_required", message: "Internal review requires an active acquired workspace lease." }
    : review.criteria.length === 0 && !review.reviewer_plan
      ? { code: "unsupported_review_shape", message: "Internal review requires review.criteria or review.reviewer_plan in the approved packet." }
      : {
          code: "manual_internal_review_required",
          message: "Local internal review never derives PASS/FAIL/BLOCKED from packet text. Manual review evidence is required for internal review resolution.",
        };

  const problem = blockedProblem ? sanitizeValue(blockedProblem, contexts) : null;
  const status = "BLOCKED";
  const finishedAt = clock().toISOString();
  const summary = resultSummary(status, problem);
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
    },
  };
}
