/** Durable requirement-zone planning for bounded harness dispatch. */
import { canonicalJson, isRecord, nonEmptyString, sha256Hex } from "../shared/primitives.js";

function packetScope(snapshot) {
  const packet = isRecord(snapshot?.packet) ? snapshot.packet : {};
  const scm = isRecord(snapshot?.scm_target) ? snapshot.scm_target : {};
  return {
    task_id: nonEmptyString(snapshot?.task_id),
    repo: nonEmptyString(scm.repo),
    issue_number: scm.issue_number ?? null,
    source_path_present: Boolean(nonEmptyString(packet.source_path)),
  };
}

export function buildResponsibilityPlan(snapshot, { purpose = "implementation_dispatch", sourceRefs = [] } = {}) {
  const executionEpoch = Number.isSafeInteger(snapshot?.execution?.current_epoch) ? snapshot.execution.current_epoch : 0;
  const role = purpose === "review_attempt" ? "reviewer" : purpose === "fix_attempt" || purpose === "resolver_attempt" ? "fixer" : "implementer";
  const zoneId = `${purpose}:default`;
  const base = {
    schema_version: "responsibility-plan.v1",
    run_id: nonEmptyString(snapshot?.run_id),
    task_id: nonEmptyString(snapshot?.task_id),
    execution_epoch: executionEpoch,
    purpose,
    source_refs: sourceRefs.filter(isRecord),
    packet_scope: packetScope(snapshot),
    zones: [{ id: zoneId, role, focus: "approved packet implementation slice", dependencies: [] }],
    role_assignments: [{ role, zone_id: zoneId, worker_count: 1 }],
    dependencies: [],
    budget_hints: { sequential: true, max_workers: 1 },
    deadline_hints: {},
    fan_out_rationale: "Default sequential single-zone fan-out; split only when approved packet zones are independent enough.",
    sequential: true,
  };
  const planId = sha256Hex(canonicalJson(base));
  return {
    plan: { ...base, responsibility_plan_id: planId },
    artifactPath: `artifacts/responsibility-plan/${purpose}-${planId.slice(0, 16)}.json`,
  };
}
