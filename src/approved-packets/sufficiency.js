import { SCHEMA_VERSION, SUFFICIENCY_STATUS } from "../execution-runs/constants.js";
import { canonicalJson, isRecord, nonEmptyString, safeIdPart, sha256Hex, toStringArray } from "../shared/primitives.js";

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeIssueNumber(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const text = nonEmptyString(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeApproval(rawPacket) {
  const approval = isRecord(rawPacket.approval) ? rawPacket.approval : {};
  const status = firstNonEmpty(approval.status, rawPacket.approval_status).toLowerCase();
  const approved = rawPacket.approved === true || approval.approved === true || status === "approved";

  return {
    approved,
    status: status || (approved ? "approved" : ""),
    approved_by: firstNonEmpty(approval.approved_by, approval.approvedBy, rawPacket.approved_by, rawPacket.approvedBy),
    approved_at: firstNonEmpty(approval.approved_at, approval.approvedAt, rawPacket.approved_at, rawPacket.approvedAt),
  };
}

function normalizeImplementation(rawPacket) {
  const implementation = isRecord(rawPacket.implementation) ? rawPacket.implementation : {};
  return firstNonEmpty(
    implementation.instructions,
    implementation.summary,
    rawPacket.implementation_instructions,
    rawPacket.implementationInstructions,
    rawPacket.instructions,
  );
}

function normalizeVerification(rawPacket) {
  const verification = isRecord(rawPacket.verification) ? rawPacket.verification : {};
  const commands = toStringArray(verification.commands ?? rawPacket.verification_commands ?? rawPacket.verificationCommands);
  const expectations = firstNonEmpty(
    verification.expectations,
    verification.expected,
    rawPacket.verification_expectations,
    rawPacket.verificationExpectations,
  );
  return { expectations, commands };
}

function normalizeReview(rawPacket) {
  const review = isRecord(rawPacket.review) ? rawPacket.review : {};
  const criteria = toStringArray(review.criteria ?? rawPacket.review_criteria ?? rawPacket.reviewCriteria);
  const reviewerPlan = firstNonEmpty(review.reviewer_plan, review.reviewerPlan, rawPacket.reviewer_plan, rawPacket.reviewerPlan);
  return { criteria, reviewer_plan: reviewerPlan };
}

function normalizeScope(rawPacket) {
  const scope = isRecord(rawPacket.scope) ? rawPacket.scope : {};
  const goal = firstNonEmpty(scope.goal, rawPacket.goal);
  const nonGoals = toStringArray(scope.non_goals ?? scope.nonGoals ?? rawPacket.non_goals ?? rawPacket.nonGoals);
  const acceptanceCriteria = toStringArray(
    scope.acceptance_criteria
      ?? scope.acceptanceCriteria
      ?? rawPacket.acceptance_criteria
      ?? rawPacket.acceptanceCriteria,
  );
  return { goal, non_goals: nonGoals, acceptance_criteria: acceptanceCriteria };
}

function normalizeConflictSurface(rawPacket) {
  const locks = isRecord(rawPacket.locks) ? rawPacket.locks : {};
  return toStringArray(rawPacket.conflict_surface ?? rawPacket.conflictSurface ?? locks.conflict_surface ?? locks.conflictSurface);
}

export function normalizePacket(rawPacket, { index = 0, sourcePath = "" } = {}) {
  if (!isRecord(rawPacket)) {
    const taskId = `packet-${index + 1}`;
    const safeTaskId = safeIdPart(taskId, `packet-${index + 1}`);
    const packetHash = sha256Hex(canonicalJson(rawPacket) ?? "undefined");
    return {
      schema_version: SCHEMA_VERSION,
      raw: rawPacket,
      task_id: taskId,
      safe_task_id: safeTaskId,
      source_path: sourcePath,
      scm_target: {},
      approval: {},
      scope: { goal: "", non_goals: [], acceptance_criteria: [] },
      implementation_instructions: "",
      verification: { expectations: "", commands: [] },
      review: { criteria: [], reviewer_plan: "" },
      conflict_surface: [],
      valid_shape: false,
      missing_fields: ["packet_object"],
      packet_hash: packetHash,
      run_id: `run_${safeTaskId}_${packetHash.slice(0, 12)}`,
      sufficiency_status: SUFFICIENCY_STATUS.FAIL,
      sufficient: false,
    };
  }

  const profile = isRecord(rawPacket.github) ? rawPacket.github : {};
  const scm = isRecord(rawPacket.scm_target) ? rawPacket.scm_target : profile;
  const taskId = firstNonEmpty(rawPacket.task_id, rawPacket.taskId, rawPacket.id) || `packet-${index + 1}`;
  const normalized = {
    schema_version: SCHEMA_VERSION,
    raw: rawPacket,
    task_id: taskId,
    safe_task_id: safeIdPart(taskId, `packet-${index + 1}`),
    source_path: sourcePath,
    scm_target: {
      provider: firstNonEmpty(scm.provider, rawPacket.provider, profile.provider) || "github",
      repo: firstNonEmpty(scm.repo, profile.repo, rawPacket.repo),
      issue_number: normalizeIssueNumber(scm.issue_number ?? scm.issueNumber ?? profile.issue_number ?? profile.issueNumber ?? rawPacket.issue_number ?? rawPacket.issueNumber ?? rawPacket.issue),
      intended_branch: firstNonEmpty(scm.intended_branch, scm.intendedBranch, scm.branch, profile.intended_branch, profile.intendedBranch, profile.branch, rawPacket.branch, rawPacket.intended_branch, rawPacket.intendedBranch),
      base_branch: firstNonEmpty(scm.base_branch, scm.baseBranch, scm.base, profile.base_branch, profile.baseBranch, profile.base, rawPacket.base_branch, rawPacket.baseBranch, rawPacket.base),
    },
    approval: normalizeApproval(rawPacket),
    scope: normalizeScope(rawPacket),
    implementation_instructions: normalizeImplementation(rawPacket),
    verification: normalizeVerification(rawPacket),
    review: normalizeReview(rawPacket),
    conflict_surface: normalizeConflictSurface(rawPacket),
    valid_shape: true,
  };

  const missing = [];
  if (!normalized.approval.approved) missing.push("approval.approved");
  if (!normalized.scm_target.repo) missing.push("scm_target.repo");
  if (!normalized.scm_target.issue_number) missing.push("scm_target.issue_number");
  if (!normalized.scm_target.intended_branch) missing.push("scm_target.intended_branch");
  if (!normalized.scope.goal && normalized.scope.acceptance_criteria.length === 0) missing.push("scope.goal_or_acceptance_criteria");
  if (!normalized.implementation_instructions) missing.push("implementation.instructions");
  if (!normalized.verification.expectations && normalized.verification.commands.length === 0) missing.push("verification.expectations_or_commands");
  if (normalized.review.criteria.length === 0 && !normalized.review.reviewer_plan) missing.push("review.criteria_or_reviewer_plan");
  if (normalized.conflict_surface.length === 0) missing.push("conflict_surface");

  const packetHash = sha256Hex(canonicalJson(rawPacket));
  const sufficient = missing.length === 0;

  return {
    ...normalized,
    packet_hash: packetHash,
    run_id: `run_${normalized.safe_task_id}_${packetHash.slice(0, 12)}`,
    missing_fields: missing,
    sufficiency_status: sufficient ? SUFFICIENCY_STATUS.PASS : SUFFICIENCY_STATUS.FAIL,
    sufficient,
  };
}

export function normalizePacketList(raw, options = {}) {
  const packets = Array.isArray(raw) ? raw : Array.isArray(raw?.packets) ? raw.packets : [];
  return packets.map((packet, index) => normalizePacket(packet, { ...options, index }));
}

export function summarizePacketReports(reports) {
  const sufficient = reports.filter((report) => report.sufficient).length;
  const insufficient = reports.length - sufficient;
  return {
    schema_version: SCHEMA_VERSION,
    total: reports.length,
    sufficient,
    insufficient,
    autonomous_discovery: false,
    remote_writes: false,
    task_execution: false,
  };
}
