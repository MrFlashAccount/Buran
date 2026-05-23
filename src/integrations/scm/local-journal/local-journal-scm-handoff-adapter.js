/** No-network local journal implementation of the provider-neutral SCM handoff port. */
import { buildScmHandoffPlan, buildScmHandoffResult } from "../../../core/modules/scm-handoff/services/scm-handoff-projection.js";
import { assertScmHandoffPort } from "../../../core/modules/scm-handoff/ports/scm-handoff-port.js";
import { sha256Hex } from "../../../shared/primitives.js";

export const LOCAL_SCM_HANDOFF_MODE = "local_fake";
export const LOCAL_SCM_HANDOFF_ADAPTER = "local-scm-handoff";
export const LOCAL_JOURNAL_SCM_HANDOFF_ADAPTER = LOCAL_SCM_HANDOFF_ADAPTER;

function projectionBaseKey(snapshot) {
  const target = snapshot?.scm_target && typeof snapshot.scm_target === "object" ? snapshot.scm_target : snapshot?.github || {};
  return [
    snapshot?.run_id || "",
    "handoff_target",
    snapshot?.execution?.current_epoch || 0,
    snapshot?.gates?.verification?.current_attempt || 0,
    snapshot?.gates?.internal_review?.current_attempt || 0,
    target.repo || "",
    target.issue_number ?? "",
    target.intended_branch || "",
    target.base_branch || "",
  ].join(":");
}

function buildFakeHandoffNumber(snapshot) {
  const digest = sha256Hex(projectionBaseKey(snapshot)).slice(0, 8);
  return 100000 + (Number.parseInt(digest, 16) % 900000);
}

function buildLocalHandoffUrl(repo, targetNumber) {
  const safeRepo = encodeURIComponent(repo || "unknown-repo");
  return `local://scm-handoff/${safeRepo}/target/${targetNumber}`;
}

function buildLocalHandoffTarget(snapshot, plan) {
  const targetNumber = buildFakeHandoffNumber(snapshot);
  return {
    number: targetNumber,
    url: buildLocalHandoffUrl(plan.repo, targetNumber),
    repo: plan.repo,
    issue_number: plan.issueNumber,
    head_branch: plan.headBranch,
    base_branch: plan.baseBranch,
    state: "open",
    draft: false,
    title: plan.title,
    projection_mode: plan.mode,
    projected_at: plan.recordedAt,
    actor: plan.actor,
  };
}

export class LocalJournalScmHandoffAdapter {
  constructor({ adapter = LOCAL_SCM_HANDOFF_ADAPTER, mode = LOCAL_SCM_HANDOFF_MODE } = {}) {
    this.adapter = adapter;
    this.mode = mode;
    this.externalSideEffects = false;
  }

  plan(snapshot, options = {}) {
    return buildScmHandoffPlan(snapshot, {
      ...options,
      adapter: this.adapter,
      mode: this.mode,
      externalSideEffects: false,
    });
  }

  async execute(snapshot, plan) {
    return buildScmHandoffResult(snapshot, plan, {
      status: "projected_local",
      handoffTarget: buildLocalHandoffTarget(snapshot, plan),
      externalSideEffects: false,
    });
  }
}

export function createLocalJournalScmHandoffAdapter(options = {}) {
  return assertScmHandoffPort(new LocalJournalScmHandoffAdapter(options));
}

export function createLocalScmHandoffAdapter() {
  return createLocalJournalScmHandoffAdapter();
}

export function buildLocalScmHandoffProjection(snapshot, options = {}) {
  const adapter = createLocalScmHandoffAdapter();
  const plan = adapter.plan(snapshot, options);
  return buildScmHandoffResult(snapshot, plan, {
    status: "projected_local",
    handoffTarget: buildLocalHandoffTarget(snapshot, plan),
    externalSideEffects: false,
  });
}
