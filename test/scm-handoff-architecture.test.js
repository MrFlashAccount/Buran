import test from "node:test";
import assert from "node:assert/strict";

import { runScmHandoffStage } from "../src/application/scm-handoff.js";
import { assertScmHandoffPort, SCM_HANDOFF_PORT, SCM_HANDOFF_PORT_METHODS } from "../src/core/modules/scm-handoff/ports/scm-handoff-port.js";
import { createLocalJournalScmHandoffAdapter } from "../src/integrations/scm/local-journal/local-journal-scm-handoff-adapter.js";
import { GitHubIntegration, GitHubScmHandoffAdapter } from "../src/integrations/scm/github/index.js";
import {
  ExecutionRun,
  RegistryRepositoryPort,
  SCHEMA_VERSION,
  TERMINAL_STATES,
  assertTransitionAllowed,
  buildTransitionEvent,
  validateTransition,
} from "../src/core/modules/execution-runs/index.js";
import { WorkspaceLease, WorkspaceLeaseServicePort } from "../src/core/modules/workspace-leases/index.js";
import { ScmHandoffProjection, ScmHandoffTarget } from "../src/core/modules/scm-handoff/index.js";
import { createIntegrationDescriptor } from "../src/core/ports/integration.js";
import { WorkspacePreparationInspectorPort } from "../src/core/ports/workspace-preparation-inspector.js";

function snapshot() {
  return {
    run_id: "run_scm_handoff_architecture",
    task_id: "scm-handoff-architecture",
    state: "handoff_ready",
    execution: { current_epoch: 1 },
    gates: {
      verification: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [{ path: "artifacts/verification.json", sha256: "a".repeat(64) }] },
      internal_review: { status: "PASS", current_epoch: 1, current_attempt: 1, artifact_refs: [{ path: "artifacts/review.json", sha256: "b".repeat(64) }] },
    },
    scm_target: {
      repo: "example-owner/example-repo",
      issue_number: 17,
      intended_branch: "feature/scm-handoff",
      base_branch: "main",
    },
    github: {},
    projection_ledger: {},
  };
}

function fakeRegistry() {
  const noop = async () => ({});
  return {
    appendRunEvent: noop,
    commitRunTransition: noop,
    createBatchFromPacketReports: noop,
    createRunFromPacketReport: noop,
    getRegistryPaths: () => ({}),
    getRunPaths: () => ({}),
    hashRunSnapshot: () => "",
    listRunDirs: async () => [],
    readEventsFile: async () => [],
    readRunSnapshot: noop,
    recordArtifact: noop,
    recordGateResult: noop,
    async recordProjectionIntent(_registryRoot, _runId, payload) {
      return { status: "recorded", run: snapshot(), artifact_ref: { path: payload.artifactPath, sha256: "c".repeat(64) }, event: { sequence: 1 } };
    },
    async recordProjectionResult(_registryRoot, _runId, payload) {
      return { status: "recorded", run: { ...snapshot(), handoff_target: payload.handoff_target }, artifact_ref: { path: payload.artifactPath, sha256: "d".repeat(64) }, event: { sequence: 2 } };
    },
    rebuildIndexes: noop,
    removeLeaseRecordsForRun: noop,
    async transitionRun(_registryRoot, _runId, { toState }) {
      return { run: { ...snapshot(), state: toState }, event: { sequence: 3 } };
    },
    writeRegistryReport: noop,
    writeRunSnapshot: noop,
  };
}

test("canonical execution-runs core exports constants and state-machine authority", () => {
  assert.equal(SCHEMA_VERSION, "execution-run.v2");
  assert.equal(TERMINAL_STATES.has("ready_for_manual_review"), true);
  assert.deepEqual(validateTransition({ fromState: "handoff_ready", toState: "ready_for_manual_review", snapshot: null }), { ok: true, reason: "allowed transition" });
  assert.throws(() => assertTransitionAllowed({ fromState: "ready_for_manual_review", toState: "running" }), /terminal state/);
  const event = buildTransitionEvent({ runId: "run_arch", sequence: 1, timestamp: "2026-05-21T20:00:00.000Z", fromState: "packet_received", toState: "queued", actor: "test" });
  assert.equal(event.schema_version, SCHEMA_VERSION);
  assert.equal(event.type, "transition");
});

test("SCM handoff port is explicit and rejects missing methods", () => {
  assert.equal(SCM_HANDOFF_PORT, "buran.core.scmHandoff");
  assert.deepEqual(SCM_HANDOFF_PORT_METHODS, ["plan", "execute"]);
  assert.throws(() => assertScmHandoffPort({ plan() {} }), /execute/);
});

test("core exposes named entities, value objects, and port classes", () => {
  const run = new ExecutionRun(snapshot());
  assert.equal(run.id.toString(), "run_scm_handoff_architecture");
  assert.equal(run.state, "handoff_ready");
  assert.equal(run.scmTarget().base_branch, "main");
  assert.equal(RegistryRepositoryPort.portName, "buran.core.executionRuns.registryRepository");
  assert.equal(WorkspaceLeaseServicePort.portName, "buran.core.workspaceLeases.workspaceLeaseService");
  assert.equal(WorkspacePreparationInspectorPort.portName, "buran.core.workspacePreparationInspector");

  const lease = new WorkspaceLease({ lease_id: "lease-1", run_id: run.id.toString(), workspace_id: "ws", workspace_path: "/tmp/ws", expires_at: "2026-05-21T21:00:00.000Z" });
  assert.equal(lease.isExpired(new Date("2026-05-21T22:00:00.000Z")), true);

  const target = new ScmHandoffTarget({
    number: 42,
    url: "https://github.com/example-owner/example-repo/pull/42",
    repo: "example-owner/example-repo",
    issue_number: 17,
    head_branch: "feature/scm-handoff",
    base_branch: "main",
    state: "open",
    draft: false,
    title: "Buran handoff",
  });
  const projection = new ScmHandoffProjection({ result: { status: "created", adapter: "github" }, handoffTarget: target.toObject() });
  assert.equal(projection.isSuccessful(), true);
});

test("application accepts any adapter implementing the explicit SCM handoff port", async () => {
  const local = createLocalJournalScmHandoffAdapter();
  const calls = [];
  const fakeAdapter = assertScmHandoffPort({
    adapter: "fake-scm-handoff-adapter",
    mode: "fake",
    externalSideEffects: false,
    plan(current, options) {
      calls.push("plan");
      const plan = local.plan(current, options);
      return { ...plan, adapter: this.adapter, mode: this.mode, externalSideEffects: false };
    },
    execute(current, plan) {
      calls.push("execute");
      return local.execute(current, plan);
    },
  });

  const result = await runScmHandoffStage({
    registryRoot: "/tmp/registry",
    runId: "run_scm_handoff_architecture",
    current: snapshot(),
    previousState: "handoff_ready",
    stepsTaken: [],
    blockers: [],
    warnings: [],
    clock: () => new Date("2026-05-21T20:00:00.000Z"),
    actor: "test",
    scmHandoffAdapter: fakeAdapter,
    registryRepository: fakeRegistry(),
  });

  assert.deepEqual(calls, ["plan", "execute"]);
  assert.equal(result.outcome, "completed");
  assert.equal(result.projection.adapter, "fake-scm-handoff-adapter");
});

test("integration descriptor helper is imported by concrete integrations", () => {
  const descriptor = createIntegrationDescriptor({
    name: "example-integration",
    kind: "scm",
    boundary: "example IO",
  });
  assert.deepEqual(descriptor, {
    name: "example-integration",
    kind: "scm",
    boundary: "example IO",
    implementsPorts: [],
    externalSideEffects: false,
  });
});

test("GitHubScmHandoffAdapter composes GitHubIntegration instead of a loose function bag", () => {
  const integration = new GitHubIntegration({ enabled: false, allowedRepos: [], client: { listPullRequests() {} } });
  const adapter = new GitHubScmHandoffAdapter({ integration });
  assert.equal(adapter.integration, integration);
  assert.equal(typeof adapter.plan, "function");
  assert.equal(typeof adapter.execute, "function");
  assert.throws(() => new GitHubScmHandoffAdapter({ integration: { projectPr() {} } }), /projectPullRequest/);
});
