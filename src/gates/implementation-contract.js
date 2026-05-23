import { sanitizePublicReportForOutput } from "../observability/index.js";
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";
import { harnessAdapterId, normalizeHarnessStatus } from "../core/ports/harness-runtime.js";

const DISPATCH_STATUS = "dispatch_requested";
const DISPATCH_SCHEMA_VERSION = "implementation-dispatch-intent.v1";
const DISPATCH_RESULT_SCHEMA_VERSION = "implementation-dispatch-result.v1";
export const IMPLEMENTATION_DISPATCH_ADAPTER = "implementation-harness-dispatch.v1";
export const DEFAULT_UNAVAILABLE_ADAPTER = "implementation-harness-unavailable.v1";
const DISPATCH_EVIDENCE_REQUIRED_CODE = "implementation_dispatch_evidence_required";
const DISPATCH_EVIDENCE_REQUIRED_MESSAGE = "Implementation harness dispatch must return immutable implementation evidence before verification.";
const DISPATCH_PROVENANCE_MISMATCH_CODE = "implementation_dispatch_provenance_mismatch";
const DISPATCH_PROVENANCE_MISMATCH_MESSAGE = "Implementation harness dispatch result provenance does not match the recorded dispatch intent.";
const DISPATCH_EVIDENCE_MAX_KEYS = 12;
const DISPATCH_EVIDENCE_MAX_ITEMS = 50;
const DISPATCH_EVIDENCE_MAX_STRING = 240;
const DISPATCH_EVIDENCE_BLOCKED_KEY_PATTERN = /(^|_)(prompt|transcript|stdout|stderr|output|raw|content|body|markdown|log|logs|session)($|_)/i;
const DISPATCH_EVIDENCE_FILE_KEYS = new Set(["files_changed", "changed_files"]);
const DISPATCH_EVIDENCE_STRING_KEYS = new Set(["implementation_result_id", "commit_sha", "patch_sha", "branch"]);
const DISPATCH_EVIDENCE_REF_KEYS = new Set(["artifact_ref", "result_artifact_ref", "implementation_artifact_ref"]);
const DISPATCH_EVIDENCE_REF_LIST_KEYS = new Set(["artifact_refs", "result_artifact_refs", "implementation_artifact_refs"]);

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
  return DISPATCH_EVIDENCE_FILE_KEYS.has(key)
    || DISPATCH_EVIDENCE_STRING_KEYS.has(key)
    || DISPATCH_EVIDENCE_REF_KEYS.has(key)
    || DISPATCH_EVIDENCE_REF_LIST_KEYS.has(key);
}

function sanitizeDispatchEvidenceValue(key, value) {
  if (DISPATCH_EVIDENCE_FILE_KEYS.has(key)) return sanitizeDispatchStringList(value);
  if (DISPATCH_EVIDENCE_REF_LIST_KEYS.has(key)) return sanitizeDispatchReferenceList(value);
  if (DISPATCH_EVIDENCE_REF_KEYS.has(key)) return sanitizeDispatchReference(value);
  if (DISPATCH_EVIDENCE_STRING_KEYS.has(key)) return truncateDispatchString(value);
  return undefined;
}

export function sanitizeImplementationDispatchEvidence(evidence) {
  if (!isRecord(evidence)) return {};

  const output = {};
  const allowedEntries = Object.entries(evidence)
    .map(([rawKey, value]) => [nonEmptyString(rawKey).toLowerCase(), value])
    .filter(([key]) => isAllowedDispatchEvidenceKey(key))
    .slice(0, DISPATCH_EVIDENCE_MAX_KEYS);

  for (const [key, value] of allowedEntries) {
    const sanitizedValue = sanitizeDispatchEvidenceValue(key, value);
    if (sanitizedValue === undefined) continue;
    output[key] = sanitizedValue;
  }

  return output;
}

function hasImmutableDispatchReference(value) {
  if (!isRecord(value)) return false;
  return Boolean(nonEmptyString(value.sha256));
}

function hasImmutableDispatchReferenceList(value) {
  return Array.isArray(value) && value.some((entry) => hasImmutableDispatchReference(entry));
}

export function hasMeaningfulImplementationDispatchCompletionEvidence(evidence) {
  if (!isRecord(evidence)) return false;
  const changedFiles = evidence.files_changed || evidence.changed_files;
  const hasChangedFiles = Array.isArray(changedFiles) && changedFiles.length > 0;
  const hasImmutableResultIdentity = Boolean(
    evidence.commit_sha
      || evidence.patch_sha
      || hasImmutableDispatchReference(evidence.artifact_ref)
      || hasImmutableDispatchReference(evidence.result_artifact_ref)
      || hasImmutableDispatchReference(evidence.implementation_artifact_ref)
      || hasImmutableDispatchReferenceList(evidence.artifact_refs)
      || hasImmutableDispatchReferenceList(evidence.result_artifact_refs)
      || hasImmutableDispatchReferenceList(evidence.implementation_artifact_refs),
  );
  return hasChangedFiles && hasImmutableResultIdentity;
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
  const normalized = normalizeHarnessStatus(value);
  if (["COMPLETED", "BLOCKED", "FAILED", "PENDING", "UNKNOWN", "STALE", "CANCELLED"].includes(normalized)) return normalized;
  return "BLOCKED";
}

export function implementationDispatchStatusSummary(status) {
  if (status === "COMPLETED") return "Implementation harness dispatch completed and returned durable implementation evidence.";
  if (status === "FAILED") return "Implementation harness dispatch failed inside the approved envelope.";
  if (status === "PENDING") return "Implementation harness dispatch is pending; wait for worker completion evidence.";
  if (status === "UNKNOWN" || status === "STALE") return "Implementation harness dispatch status is not currently provable.";
  if (status === "CANCELLED") return "Implementation harness dispatch was cancelled before completion.";
  return "Implementation harness dispatch is blocked.";
}

function buildProblem(code, message, extra = {}) {
  return { code, message, ...extra };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function jsonEquivalent(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export function buildImplementationDispatchIntentArtifactRef(intent, { intentArtifactPath = "" } = {}) {
  const dispatchIntentId = nonEmptyString(intent?.dispatch_intent_id);
  const artifactPath = nonEmptyString(intentArtifactPath) || `artifacts/implementation-dispatch/intent-${dispatchIntentId.slice(0, 16)}.json`;
  return {
    path: artifactPath,
    sha256: sha256Hex(`${JSON.stringify(intent, null, 2)}\n`),
  };
}

function captureImplementationDispatchProvenance(snapshot, intent, { intentArtifactPath = "" } = {}) {
  const capturedIntent = cloneJson(intent);
  return deepFreeze({
    run_id: nonEmptyString(snapshot?.run_id),
    task_id: nonEmptyString(snapshot?.task_id),
    dispatch_intent_id: nonEmptyString(capturedIntent?.dispatch_intent_id),
    dispatch_intent_artifact: buildImplementationDispatchIntentArtifactRef(capturedIntent, { intentArtifactPath }),
    packet_artifact: cloneJson(capturedIntent?.packet_artifact),
    workspace_preparation_artifact: cloneJson(capturedIntent?.workspace_preparation_artifact),
    worker_task_id: nonEmptyString(capturedIntent?.worker_task_id),
    worker_task_role: nonEmptyString(capturedIntent?.worker_task_role),
    worker_task_epoch: capturedIntent?.worker_task_epoch ?? null,
    worker_task_attempt: capturedIntent?.worker_task_attempt ?? null,
    completion_authority: nonEmptyString(capturedIntent?.completion_authority),
    completion_idempotency_key: nonEmptyString(capturedIntent?.completion_idempotency_key),
  });
}

function provenanceMismatchProblem(field) {
  return buildProblem(DISPATCH_PROVENANCE_MISMATCH_CODE, DISPATCH_PROVENANCE_MISMATCH_MESSAGE, { field });
}

function resultShapeProblem(field) {
  return buildProblem("implementation_dispatch_result_invalid", "Implementation harness dispatch result does not match the required result shape.", { field });
}

function validateRequiredStringField(result, captured, field, { requireCompleteProvenance }) {
  const actual = nonEmptyString(result?.[field]);
  const expected = nonEmptyString(captured?.[field]);
  if (requireCompleteProvenance && !actual) return provenanceMismatchProblem(field);
  if (actual && actual !== expected) return provenanceMismatchProblem(field);
  return null;
}

function validateArtifactRefField(result, captured, field, { requireCompleteProvenance }) {
  const actual = result?.[field];
  const expected = captured?.[field];
  if (requireCompleteProvenance && !isRecord(actual)) return provenanceMismatchProblem(field);
  if (!isRecord(actual)) return null;

  const actualPath = nonEmptyString(actual.path);
  const actualSha = nonEmptyString(actual.sha256);
  const expectedPath = nonEmptyString(expected?.path);
  const expectedSha = nonEmptyString(expected?.sha256);
  if (requireCompleteProvenance && (!actualPath || !actualSha)) return provenanceMismatchProblem(field);
  if ((actualPath && actualPath !== expectedPath) || (actualSha && actualSha !== expectedSha)) {
    return provenanceMismatchProblem(field);
  }
  return null;
}

function validateJsonArtifactField(result, captured, field, { requireCompleteProvenance }) {
  const actual = result?.[field];
  const expected = captured?.[field];
  if (requireCompleteProvenance && !isRecord(actual)) return provenanceMismatchProblem(field);
  if (isRecord(actual) && !jsonEquivalent(actual, expected)) return provenanceMismatchProblem(field);
  return null;
}

export function validateImplementationDispatchResultProvenance(result, intent, { requireCompleteProvenance = false, intentArtifactPath = "" } = {}) {
  if (!isRecord(result)) return null;
  const captured = captureImplementationDispatchProvenance({ run_id: intent?.run_id, task_id: intent?.task_id }, intent, { intentArtifactPath });
  const stringProblem = validateRequiredStringField(result, captured, "run_id", { requireCompleteProvenance })
    || validateRequiredStringField(result, captured, "task_id", { requireCompleteProvenance })
    || validateRequiredStringField(result, captured, "dispatch_intent_id", { requireCompleteProvenance });
  if (stringProblem) return stringProblem;
  const workerTaskProblem = validateRequiredStringField(result, captured, "worker_task_id", { requireCompleteProvenance: false })
    || validateRequiredStringField(result, captured, "worker_task_role", { requireCompleteProvenance: false });
  if (workerTaskProblem) return workerTaskProblem;
  const artifactProblem = validateArtifactRefField(result, captured, "dispatch_intent_artifact", { requireCompleteProvenance })
    || validateJsonArtifactField(result, captured, "packet_artifact", { requireCompleteProvenance })
    || validateJsonArtifactField(result, captured, "workspace_preparation_artifact", { requireCompleteProvenance });
  if (artifactProblem) return artifactProblem;
  return null;
}

export function validateImplementationDispatchResultReport(result, intent, { requireCompleteProvenance = true, intentArtifactPath = "" } = {}) {
  if (!isRecord(result)) return resultShapeProblem("result");
  if (result.schema_version !== DISPATCH_RESULT_SCHEMA_VERSION) return resultShapeProblem("schema_version");
  const status = nonEmptyString(result.status).toUpperCase();
  if (!["COMPLETED", "BLOCKED", "FAILED", "PENDING", "UNKNOWN", "STALE", "CANCELLED"].includes(status)) return resultShapeProblem("status");
  const provenanceProblem = validateImplementationDispatchResultProvenance(result, intent, { requireCompleteProvenance, intentArtifactPath });
  if (provenanceProblem) return provenanceProblem;
  if (status === "COMPLETED" && !hasMeaningfulImplementationDispatchCompletionEvidence(result.evidence)) {
    return buildProblem(DISPATCH_EVIDENCE_REQUIRED_CODE, DISPATCH_EVIDENCE_REQUIRED_MESSAGE, { field: "evidence" });
  }
  return null;
}

export function isUnavailableImplementationDispatchResult(result) {
  if (!isRecord(result)) return false;
  return nonEmptyString(result.adapter) === DEFAULT_UNAVAILABLE_ADAPTER
    || nonEmptyString(result.actor) === DEFAULT_UNAVAILABLE_ADAPTER
    || nonEmptyString(result.problem?.code) === "implementation_dispatch_unavailable";
}

function sanitizeProblemCode(value, fallback) {
  const code = nonEmptyString(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 120);
  if (!code || DISPATCH_EVIDENCE_BLOCKED_KEY_PATTERN.test(code)) return fallback;
  return code;
}

function buildDispatchProblem(status, result, evidenceRequired) {
  const fallbackCode = evidenceRequired
    ? DISPATCH_EVIDENCE_REQUIRED_CODE
    : status === "FAILED"
      ? "implementation_dispatch_failed"
      : "implementation_dispatch_blocked";
  return buildProblem(
    sanitizeProblemCode(result?.problem?.code, fallbackCode),
    evidenceRequired ? DISPATCH_EVIDENCE_REQUIRED_MESSAGE : implementationDispatchStatusSummary(status),
  );
}

function normalizeResult(rawResult, snapshot) {
  const result = isRecord(rawResult) ? rawResult : {};
  const normalizedStatus = normalizeDispatchStatus(result.status);
  const evidence = sanitizeImplementationDispatchEvidence(result.evidence);
  const evidenceRequired = normalizedStatus === "COMPLETED" && !hasMeaningfulImplementationDispatchCompletionEvidence(evidence);
  const status = evidenceRequired ? "BLOCKED" : normalizedStatus;
  const problem = status === "COMPLETED"
    ? null
    : sanitizeValue(buildDispatchProblem(status, result, evidenceRequired), snapshot);

  return sanitizeValue({
    status,
    summary: evidenceRequired ? DISPATCH_EVIDENCE_REQUIRED_MESSAGE : implementationDispatchStatusSummary(status),
    implementation_epoch: Number.isSafeInteger(result.implementation_epoch) ? result.implementation_epoch : 1,
    evidence,
    problem,
    adapter: nonEmptyString(result.adapter || result.adapter_id) || IMPLEMENTATION_DISPATCH_ADAPTER,
    actor: nonEmptyString(result.actor || result.adapter || result.adapter_id) || IMPLEMENTATION_DISPATCH_ADAPTER,
    adapter_task_id: truncateDispatchString(result.adapter_task_id || result.task_id || result.session_id, 160),
    adapter_status: truncateDispatchString(result.adapter_status || normalizedStatus, 80),
    heartbeat_at: truncateDispatchString(result.heartbeat_at, 80),
    status_summary_ref: sanitizeDispatchReference(result.status_summary_ref),
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
    scm_target: {
      provider: nonEmptyString(snapshot.scm_target?.provider),
      repo: nonEmptyString(snapshot.scm_target?.repo),
      issue_number: snapshot.scm_target?.issue_number ?? null,
      intended_branch: nonEmptyString(snapshot.scm_target?.intended_branch),
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
    worker_task_id: nonEmptyString(snapshot.worker_tasks?.head?.worker_task_id),
    worker_task_role: nonEmptyString(snapshot.worker_tasks?.head?.role),
    worker_task_epoch: snapshot.worker_tasks?.head?.epoch ?? snapshot.execution?.current_epoch ?? 0,
    worker_task_attempt: snapshot.worker_tasks?.head?.attempt ?? 1,
    completion_authority: nonEmptyString(snapshot.worker_tasks?.head?.authority) || IMPLEMENTATION_DISPATCH_ADAPTER,
    completion_idempotency_key: `${snapshot.run_id}:worker_completion:${nonEmptyString(snapshot.worker_tasks?.head?.worker_task_id) || "legacy"}`,
    execution_boundary: {
      status: DISPATCH_STATUS,
      adapter: "harness-runtime.v1",
      result_required_before_verification: true,
      scope_authority: "approved_packet_artifact",
      worker_task_required: Boolean(snapshot.worker_tasks?.head?.worker_task_id),
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

/**
 * Create a safe implementation-dispatch adapter used when no real implementation harness is configured.
 *
 * The adapter implements the public dispatch shape (`adapter`, `externalSideEffects`, `execute`) but never performs
 * external work. `execute()` returns a normalized BLOCKED result with `implementation_dispatch_unavailable`, allowing
 * local runner composition to fail closed before verification.
 *
 * @param {object} [options]
 * @param {string} [options.reason] Public blocked reason recorded in the dispatch result.
 * @returns {{adapter: string, externalSideEffects: boolean, execute(): Promise<object>}} Safe unavailable adapter.
 */
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

export async function executeImplementationDispatch({ snapshot, intent, adapter = createUnavailableImplementationDispatchAdapter(), clock = () => new Date(), intentArtifactPath = "", artifactDirectory = "artifacts/implementation-dispatch" } = {}) {
  if (!snapshot?.run_id) throw new Error("run snapshot is required for implementation dispatch execution");
  if (!intent?.dispatch_intent_id) throw new Error("implementation dispatch intent is required");
  const dispatchArtifactDirectory = nonEmptyString(artifactDirectory) || "artifacts/implementation-dispatch";
  const dispatchIntentArtifactPath = nonEmptyString(intentArtifactPath) || `${dispatchArtifactDirectory}/intent-${intent.dispatch_intent_id.slice(0, 16)}.json`;
  const capturedProvenance = captureImplementationDispatchProvenance(snapshot, intent, { intentArtifactPath: dispatchIntentArtifactPath });
  const capturedDispatchIntentArtifact = capturedProvenance.dispatch_intent_artifact;
  const adapterSnapshot = cloneJson(snapshot);
  const adapterIntent = cloneJson(intent);
  const adapterPacketArtifact = cloneJson(capturedProvenance.packet_artifact);
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
      const envelope = {
        schema_version: "harness-execution-envelope.v1",
        run_id: adapterIntent.run_id,
        task_id: adapterIntent.worker_task_id || adapterIntent.task_id,
        execution_epoch: adapterIntent.worker_task_epoch,
        attempt: adapterIntent.worker_task_attempt,
        purpose: adapterIntent.worker_task_role === "reviewer" ? "review_attempt" : adapterIntent.dispatch_status === "fix_attempt" ? "fix_attempt" : "implementation_dispatch",
        role: adapterIntent.worker_task_role,
        packet_artifact: adapterPacketArtifact,
        workspace_preparation_artifact: adapterIntent.workspace_preparation_artifact,
        scope_boundary: "approved_packet_artifact",
        expected_output_contract: "worker-completion-evidence.v1",
        completion_idempotency_key: adapterIntent.completion_idempotency_key,
      };
      const rawResult = typeof adapter.spawn === "function"
        ? await adapter.spawn(envelope, { idempotencyKey: adapterIntent.completion_idempotency_key, intent: adapterIntent, snapshot: adapterSnapshot, workspace_path: snapshot.workspace?.path || "" })
        : await adapter.execute({
          snapshot: adapterSnapshot,
          intent: adapterIntent,
          envelope,
          workspace_path: snapshot.workspace?.path || "",
          packet_artifact: adapterPacketArtifact,
        });
      startedAt = nonEmptyString(rawResult?.started_at);
      finishedAt = nonEmptyString(rawResult?.finished_at);
      const provenanceProblem = validateImplementationDispatchResultProvenance(rawResult, intent, { intentArtifactPath: dispatchIntentArtifactPath });
      normalized = normalizeResult(provenanceProblem ? {
        ...rawResult,
        status: "BLOCKED",
        problem: provenanceProblem,
      } : rawResult, snapshot);
    }
  } catch (error) {
    normalized = normalizeResult({
      status: "BLOCKED",
      adapter: harnessAdapterId(adapter),
      actor: harnessAdapterId(adapter),
      problem: buildProblem("implementation_dispatch_failed", nonEmptyString(error?.message) || "Implementation-harness dispatch failed."),
    }, snapshot);
  }

  const recordedAt = clock().toISOString();
  const artifactPayload = sanitizeValue({
    schema_version: DISPATCH_RESULT_SCHEMA_VERSION,
    adapter: normalized.adapter,
    run_id: capturedProvenance.run_id,
    task_id: capturedProvenance.task_id,
    dispatch_intent_id: capturedProvenance.dispatch_intent_id,
    dispatch_intent_artifact: capturedDispatchIntentArtifact,
    packet_artifact: capturedProvenance.packet_artifact,
    workspace_preparation_artifact: capturedProvenance.workspace_preparation_artifact,
    worker_task_id: capturedProvenance.worker_task_id,
    worker_task_role: capturedProvenance.worker_task_role,
    worker_task_epoch: capturedProvenance.worker_task_epoch,
    worker_task_attempt: capturedProvenance.worker_task_attempt,
    completion_authority: capturedProvenance.completion_authority,
    completion_idempotency_key: capturedProvenance.completion_idempotency_key,
    started_at: startedAt,
    finished_at: finishedAt,
    status: normalized.status,
    summary: normalized.summary,
    implementation_epoch: normalized.implementation_epoch,
    evidence: normalized.evidence,
    adapter_task_id: normalized.adapter_task_id,
    adapter_status: normalized.adapter_status,
    heartbeat_at: normalized.heartbeat_at,
    status_summary_ref: normalized.status_summary_ref,
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
    idempotency_key: `${capturedProvenance.run_id}:implementation_dispatch:${capturedProvenance.dispatch_intent_id}:${artifactHash.slice(0, 16)}`,
    artifact_path: `${dispatchArtifactDirectory}/result-${artifactHash.slice(0, 16)}.json`,
    artifact_content: artifactContent,
    public_report: artifactPayload,
    provenance: {
      kind: "implementation-dispatch-result",
      adapter: normalized.adapter,
      dispatch_intent_id: capturedProvenance.dispatch_intent_id,
      packet_artifact: capturedProvenance.packet_artifact,
      status: normalized.status,
      adapter_task_id: normalized.adapter_task_id || "",
      adapter_status: normalized.adapter_status || "",
      heartbeat_at: normalized.heartbeat_at || "",
      status_summary_ref: normalized.status_summary_ref || null,
    },
  };
}
