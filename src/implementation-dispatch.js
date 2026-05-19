import { sanitizePublicReportForOutput } from "./observability.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "./utils.js";

const DISPATCH_STATUS = "dispatch_requested";
const DISPATCH_SCHEMA_VERSION = "implementation-dispatch-intent.v1";
const DISPATCH_RESULT_SCHEMA_VERSION = "implementation-dispatch-result.v1";
const IMPLEMENTATION_DISPATCH_ADAPTER = "implementation-harness-dispatch.v1";
const DEFAULT_UNAVAILABLE_ADAPTER = "implementation-harness-unavailable.v1";
const DISPATCH_EVIDENCE_REQUIRED_CODE = "implementation_dispatch_evidence_required";
const DISPATCH_EVIDENCE_REQUIRED_MESSAGE = "Implementation harness dispatch must return immutable implementation evidence before verification.";
const DISPATCH_EVIDENCE_MAX_KEYS = 12;
const DISPATCH_EVIDENCE_MAX_ITEMS = 50;
const DISPATCH_EVIDENCE_MAX_STRING = 240;
const DISPATCH_EVIDENCE_BLOCKED_KEY_PATTERN = /(^|_)(prompt|transcript|stdout|stderr|output|raw|content|body|markdown|log|logs|session)($|_)/i;

function truncateDispatchString(value, max = DISPATCH_EVIDENCE_MAX_STRING) {
  const text = nonEmptyString(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeDispatchReference(value) {
  if (typeof value === "string") return truncateDispatchString(value);
  if (!isRecord(value)) return undefined;

  const output = {};
  const id = truncateDispatchString(value.id, 120);
  const path = truncateDispatchString(value.path);
  const sha256 = truncateDispatchString(value.sha256, 128);

  if (id) output.id = id;
  if (path) output.path = path;
  if (sha256) output.sha256 = sha256;
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeDispatchStringList(value) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const sanitized = entries
    .map((entry) => truncateDispatchString(entry))
    .filter(Boolean)
    .slice(0, DISPATCH_EVIDENCE_MAX_ITEMS);
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeDispatchReferenceList(value) {
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  const sanitized = entries
    .map((entry) => sanitizeDispatchReference(entry))
    .filter(Boolean)
    .slice(0, DISPATCH_EVIDENCE_MAX_ITEMS);
  return sanitized.length > 0 ? sanitized : undefined;
}

function isAllowedDispatchEvidenceKey(key) {
  if (!key || DISPATCH_EVIDENCE_BLOCKED_KEY_PATTERN.test(key)) return false;
  return key === "files_changed"
    || key === "changed_files"
    || /(^|_)(id|sha|branch|count|ref|refs|path|paths)$/.test(key);
}

function sanitizeDispatchEvidenceValue(key, value) {
  if (key === "files_changed" || key === "changed_files") return sanitizeDispatchStringList(value);
  if (/(^|_)(count)$/.test(key)) return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (/(^|_)(refs|paths)$/.test(key)) return sanitizeDispatchReferenceList(value);
  if (/(^|_)(ref|path)$/.test(key)) return sanitizeDispatchReference(value);
  if (/(^|_)(id|sha|branch)$/.test(key)) return truncateDispatchString(value);
  return undefined;
}

function sanitizeDispatchEvidence(evidence) {
  if (!isRecord(evidence)) return {};

  const output = {};
  for (const [rawKey, value] of Object.entries(evidence).slice(0, DISPATCH_EVIDENCE_MAX_KEYS)) {
    const key = nonEmptyString(rawKey).toLowerCase();
    if (!isAllowedDispatchEvidenceKey(key)) continue;
    const sanitizedValue = sanitizeDispatchEvidenceValue(key, value);
    if (sanitizedValue === undefined) continue;
    output[key] = sanitizedValue;
  }

  return output;
}

function workspaceContexts(snapshot) {
  const contexts = [];
  const workspacePath = nonEmptyString(snapshot?.workspace?.path);
  if (workspacePath) contexts.push({ root: workspacePath, label: "<workspace>" });
  return contexts;
}

function sanitizeValue(value, snapshot) {
  return sanitizePublicReportForOutput(value, workspaceContexts(snapshot));
}

function normalizeDispatchStatus(status) {
  const value = nonEmptyString(status).toUpperCase();
  if (["COMPLETED", "BLOCKED", "FAILED"].includes(value)) return value;
  return "BLOCKED";
}

function dispatchStatusSummary(status, problem = null) {
  if (status === "COMPLETED") return "Implementation harness dispatch completed and returned immutable implementation evidence.";
  if (problem?.message) return problem.message;
  if (status === "FAILED") return "Implementation harness dispatch failed inside the approved envelope.";
  return "Implementation harness dispatch is blocked.";
}

function buildProblem(code, message, extra = {}) {
  return { code, message, ...extra };
}

function normalizeResult(rawResult, snapshot) {
  const result = isRecord(rawResult) ? rawResult : {};
  const normalizedStatus = normalizeDispatchStatus(result.status);
  const evidence = sanitizeDispatchEvidence(result.evidence);
  const evidenceRequired = normalizedStatus === "COMPLETED" && Object.keys(evidence).length === 0;
  const status = evidenceRequired ? "BLOCKED" : normalizedStatus;
  const problem = status === "COMPLETED"
    ? null
    : sanitizeValue(isRecord(result.problem) ? result.problem : buildProblem(
        evidenceRequired
          ? DISPATCH_EVIDENCE_REQUIRED_CODE
          : status === "FAILED"
            ? "implementation_dispatch_failed"
            : "implementation_dispatch_blocked",
        evidenceRequired
          ? DISPATCH_EVIDENCE_REQUIRED_MESSAGE
          : nonEmptyString(result.summary) || dispatchStatusSummary(status),
      ), snapshot);

  return sanitizeValue({
    status,
    summary: evidenceRequired
      ? DISPATCH_EVIDENCE_REQUIRED_MESSAGE
      : nonEmptyString(result.summary) || dispatchStatusSummary(status, problem),
    implementation_epoch: Number.isSafeInteger(result.implementation_epoch) ? result.implementation_epoch : 1,
    evidence,
    problem,
    adapter: nonEmptyString(result.adapter) || IMPLEMENTATION_DISPATCH_ADAPTER,
    actor: nonEmptyString(result.actor) || IMPLEMENTATION_DISPATCH_ADAPTER,
  }, snapshot);
}

export function buildImplementationDispatchIntent(snapshot, { workspacePreparationArtifactRef } = {}) {
  if (!snapshot?.run_id) throw new Error("run snapshot is required for implementation dispatch intent");
  if (!workspacePreparationArtifactRef?.path || !workspacePreparationArtifactRef?.sha256) {
    throw new Error("workspacePreparationArtifactRef is required for implementation dispatch intent");
  }
  if (!snapshot.artifacts?.packet?.path || !snapshot.artifacts?.packet?.sha256) {
    throw new Error(`Run ${snapshot.run_id} is missing its approved packet artifact reference.`);
  }

  const intent = {
    schema_version: DISPATCH_SCHEMA_VERSION,
    dispatch_status: DISPATCH_STATUS,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    github: {
      repo: nonEmptyString(snapshot.github?.repo),
      issue_number: snapshot.github?.issue_number ?? null,
      intended_branch: nonEmptyString(snapshot.github?.intended_branch),
    },
    workspace: {
      id: snapshot.workspace?.id ?? null,
    },
    execution: {
      current_epoch: snapshot.execution?.current_epoch ?? 0,
      current_state: snapshot.state,
    },
    packet_artifact: {
      path: snapshot.artifacts.packet.path,
      sha256: snapshot.artifacts.packet.sha256,
    },
    workspace_preparation_artifact: {
      path: workspacePreparationArtifactRef.path,
      sha256: workspacePreparationArtifactRef.sha256,
    },
    execution_boundary: {
      status: DISPATCH_STATUS,
      adapter: IMPLEMENTATION_DISPATCH_ADAPTER,
      result_required_before_verification: true,
      scope_authority: "approved_packet_artifact",
    },
  };

  const dispatchIntentId = sha256Hex(canonicalJson(intent));
  return {
    intent: {
      ...intent,
      dispatch_intent_id: dispatchIntentId,
    },
    artifactPath: `artifacts/implementation-dispatch/intent-${dispatchIntentId.slice(0, 16)}.json`,
  };
}

export function createUnavailableImplementationDispatchAdapter({ reason = "Implementation-harness dispatch adapter is not configured for this local runner invocation." } = {}) {
  return {
    adapter: DEFAULT_UNAVAILABLE_ADAPTER,
    externalSideEffects: false,
    async execute() {
      return {
        status: "BLOCKED",
        adapter: DEFAULT_UNAVAILABLE_ADAPTER,
        actor: DEFAULT_UNAVAILABLE_ADAPTER,
        summary: reason,
        problem: buildProblem("implementation_dispatch_unavailable", reason),
      };
    },
  };
}

export async function executeImplementationDispatch({ snapshot, intent, adapter = createUnavailableImplementationDispatchAdapter(), clock = () => new Date() } = {}) {
  if (!snapshot?.run_id) throw new Error("run snapshot is required for implementation dispatch execution");
  if (!intent?.dispatch_intent_id) throw new Error("implementation dispatch intent is required");
  let startedAt = "";
  let finishedAt = "";
  let normalized;
  try {
    if (!adapter || typeof adapter.execute !== "function") {
      normalized = normalizeResult({
        status: "BLOCKED",
        adapter: DEFAULT_UNAVAILABLE_ADAPTER,
        actor: DEFAULT_UNAVAILABLE_ADAPTER,
        problem: buildProblem("implementation_dispatch_unavailable", "Implementation-harness dispatch adapter is not available."),
      }, snapshot);
    } else {
      const rawResult = await adapter.execute({
        snapshot,
        intent,
        workspace_path: snapshot.workspace?.path || "",
        packet_artifact: intent.packet_artifact,
      });
      startedAt = nonEmptyString(rawResult?.started_at);
      finishedAt = nonEmptyString(rawResult?.finished_at);
      normalized = normalizeResult(rawResult, snapshot);
    }
  } catch (error) {
    normalized = normalizeResult({
      status: "BLOCKED",
      adapter: nonEmptyString(adapter?.adapter) || IMPLEMENTATION_DISPATCH_ADAPTER,
      actor: nonEmptyString(adapter?.adapter) || IMPLEMENTATION_DISPATCH_ADAPTER,
      problem: buildProblem("implementation_dispatch_failed", nonEmptyString(error?.message) || "Implementation-harness dispatch failed."),
    }, snapshot);
  }

  const recordedAt = clock().toISOString();
  const artifactPayload = sanitizeValue({
    schema_version: DISPATCH_RESULT_SCHEMA_VERSION,
    adapter: normalized.adapter,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    dispatch_intent_id: intent.dispatch_intent_id,
    dispatch_intent_artifact: {
      path: `artifacts/implementation-dispatch/intent-${intent.dispatch_intent_id.slice(0, 16)}.json`,
      sha256: sha256Hex(`${JSON.stringify(intent, null, 2)}\n`),
    },
    packet_artifact: intent.packet_artifact,
    workspace_preparation_artifact: intent.workspace_preparation_artifact,
    started_at: startedAt,
    finished_at: finishedAt,
    status: normalized.status,
    summary: normalized.summary,
    implementation_epoch: normalized.implementation_epoch,
    evidence: normalized.evidence,
    problem: normalized.problem,
    actor: normalized.actor,
  }, snapshot);
  const artifactContent = `${JSON.stringify(artifactPayload, null, 2)}\n`;
  const artifactHash = sha256Hex(artifactContent);

  return {
    adapter: normalized.adapter,
    actor: normalized.actor,
    status: normalized.status,
    recorded_at: recordedAt,
    idempotency_key: `${snapshot.run_id}:implementation_dispatch:${intent.dispatch_intent_id}:${artifactHash.slice(0, 16)}`,
    artifact_path: `artifacts/implementation-dispatch/result-${artifactHash.slice(0, 16)}.json`,
    artifact_content: artifactContent,
    public_report: artifactPayload,
    provenance: {
      kind: "implementation-dispatch-result",
      adapter: normalized.adapter,
      dispatch_intent_id: intent.dispatch_intent_id,
      packet_artifact: intent.packet_artifact,
      status: normalized.status,
    },
  };
}
