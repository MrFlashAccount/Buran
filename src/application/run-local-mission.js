/**
 * Thin local mission application orchestrator. Stage-specific behavior lives in sibling modules.
 */
import { TERMINAL_STATES } from "../core/modules/execution-runs/constants.js";
import { createUnavailableImplementationDispatchAdapter } from "../gates/implementation-contract.js";
import { assertWorkspaceLeaseService } from "../core/modules/workspace-leases/ports/workspace-lease-service.js";
import { evaluateReviewReadyPolicy } from "../stack-workflow/review-ready-policy.js";
import { assertRegistryRepository } from "../core/modules/execution-runs/ports/registry-repository.js";
import { nonEmptyString } from "../shared/primitives.js";

import { RUNNER_ACTOR } from "./mission-context.js";
import { buildIssue, buildRunnerReport, buildStep, leaseRequiredMessage } from "./final-report.js";
import { runImplementationDispatchStage } from "./mission-phase-runner.js";
import { runVerificationStage, runInternalReviewStage } from "./gate-pipeline.js";
import { runScmHandoffStage } from "./scm-handoff.js";
import { runFixLoopStage } from "./fix-review-loop.js";

async function runLocalMissionStep({ registryRoot, runId, workspaceId = "", workspacePath = "", ttlMs = "", clock = () => new Date(), actor = RUNNER_ACTOR, implementationDispatchAdapter = createUnavailableImplementationDispatchAdapter(), scmHandoffAdapter, registryRepository, workspaceLeaseService, workspacePreparationInspector, stackPrerequisite = null } = {}) {
  if (!registryRoot) throw new Error("registryRoot is required for local mission runner");
  if (!runId) throw new Error("runId is required for local mission runner");
  const registry = assertRegistryRepository(registryRepository);
  const leases = assertWorkspaceLeaseService(workspaceLeaseService);

  const stepsTaken = [];
  const blockers = [];
  const warnings = [];
  const paths = registry.getRunPaths(registryRoot, runId);

  let snapshot;
  try {
    snapshot = await registry.readRunSnapshot(paths.runPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return buildRunnerReport({
        registryRoot,
        runId,
        outcome: "failed",
        blockers: [buildIssue("run_not_found", `Run ${runId} was not found in the local registry.`)],
      });
    }
    throw error;
  }

  const previousState = snapshot.state;
  let current = snapshot;
  let workspacePreparation = null;
  let implementationDispatch = null;
  let verification = null;
  let internalReview = null;
  let fixLoop = null;
  let workflowPolicy = null;
  const withWorkflowPolicy = (report) => (workflowPolicy ? { ...report, workflow_policy: workflowPolicy } : report);
  if (stackPrerequisite) {
    const prerequisiteSnapshot = stackPrerequisite.snapshot || stackPrerequisite;
    workflowPolicy = evaluateReviewReadyPolicy(prerequisiteSnapshot, {
      currentSlice: stackPrerequisite.currentSlice || "",
      nextSlice: stackPrerequisite.nextSlice || "",
    });
    if (!workflowPolicy.allowed_to_start_next_slice) {
      const problem = buildIssue(
        "stack_prerequisite_not_review_ready",
        `Next slice cannot start until prerequisite run ${workflowPolicy.prerequisite_run_id || "<unknown>"} is review-ready.`,
        { workflow_policy: workflowPolicy },
      );
      blockers.push(problem);
      stepsTaken.push(buildStep({
        action: "stack_progression_guard",
        status: "blocked",
        fromState: current.state,
        toState: current.state,
        detail: problem.message,
      }));
      return buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "blocked",
        stepsTaken,
        blockers,
        warnings,
        workspacePreparation,
        implementationDispatch,
        verification,
        internalReview,
        fixLoop,
        workflowPolicy,
      });
    }
  }

  if (TERMINAL_STATES.has(current.state)) {
    return withWorkflowPolicy(buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      blockers: [buildIssue("terminal_state", `Run ${runId} is already terminal in state ${current.state}.`)],
    }));
  }

  if (current.state === "packet_received") {
    return withWorkflowPolicy(buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      currentState: current.state,
      outcome: "blocked",
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      blockers: [buildIssue("run_not_intaken", `Run ${runId} is still in packet_received and is not ready for local runner staging.`)],
    }));
  }

  if (current.state === "queued") {
    const transitioned = await registry.transitionRun(registryRoot, runId, {
      toState: "waiting_for_lock",
      actor,
      evidence: { reason: "local mission runner staged run for lease acquisition" },
      clock,
    });
    current = transitioned.run;
    stepsTaken.push(buildStep({
      action: "transition",
      status: "completed",
      fromState: previousState,
      toState: current.state,
      detail: "Queued run staged for explicit local lease acquisition.",
      sequence: transitioned.event.sequence,
    }));
  }

  if (current.state === "waiting_for_lock") {
    if (!nonEmptyString(workspaceId)) {
      blockers.push(buildIssue("lease_required", leaseRequiredMessage(runId)));
      return withWorkflowPolicy(buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "blocked",
        stepsTaken,
        blockers,
        warnings,
        workspacePreparation,
        implementationDispatch,
        verification,
        internalReview,
      }));
    }

    const acquired = await leases.acquire(registryRoot, runId, {
      workspaceId,
      workspacePath,
      ttlMs,
      actor,
      clock,
    });
    current = acquired.run;

    if (acquired.status === "acquired") {
      stepsTaken.push(buildStep({
        action: "lease_acquire",
        status: "completed",
        fromState: "waiting_for_lock",
        toState: current.state,
        detail: "Local workspace lease acquired without creating a checkout or dispatching work.",
        workspaceId: acquired.lease?.workspace_id || workspaceId,
        leaseId: acquired.lease?.lease_id || "",
        expiresAt: acquired.lease?.expires_at || "",
      }));
    } else {
      stepsTaken.push(buildStep({
        action: "lease_acquire",
        status: "blocked",
        fromState: "waiting_for_lock",
        toState: current.state,
        detail: "Local lease acquisition stopped on an unsafe overlap.",
        conflicts: acquired.conflicts?.length || 0,
        rolledBackRecords: acquired.rolled_back_records || 0,
      }));
      blockers.push(buildIssue("blocked_lock_conflict", "Local lease acquisition detected an unsafe overlap.", {
        conflicts: acquired.conflicts || [],
      }));
      return withWorkflowPolicy(buildRunnerReport({
        registryRoot,
        runId,
        previousState,
        currentState: current.state,
        outcome: "blocked",
        stepsTaken,
        blockers,
        warnings,
        workspacePreparation,
        implementationDispatch,
        verification,
        internalReview,
      }));
    }
  }

  if (current.state === "running") {
    const stageResult = await runImplementationDispatchStage({
      runContext: { registryRoot, runId, current, paths },
      reportState: { stepsTaken, blockers, warnings, workspacePreparation, implementationDispatch },
      services: { clock, actor, implementationDispatchAdapter, registryRepository: registry, workspacePreparationInspector },
    });
    return withWorkflowPolicy(buildRunnerReport({
      registryRoot,
      runId,
      previousState,
      ...stageResult.reportInput,
      verification,
      internalReview,
    }));
  }

  if (current.state === "verification") {
    return withWorkflowPolicy(await runVerificationStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      clock,
      actor,
      paths,
      registryRepository: registry,
    }));
  }

  if (current.state === "internal_review") {
    return withWorkflowPolicy(await runInternalReviewStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      clock,
      actor,
      paths,
      registryRepository: registry,
    }));
  }

  if (current.state === "handoff_ready") {
    return withWorkflowPolicy(await runScmHandoffStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      clock,
      actor,
      scmHandoffAdapter,
      registryRepository: registry,
    }));
  }

  if (current.state === "fix_loop") {
    return withWorkflowPolicy(await runFixLoopStage({
      registryRoot,
      runId,
      current,
      previousState,
      stepsTaken,
      blockers,
      warnings,
      workspacePreparation,
      implementationDispatch,
      verification,
      internalReview,
      clock,
      actor,
      implementationDispatchAdapter,
      registryRepository: registry,
    }));
  }

  blockers.push(buildIssue("unsupported_state", `Run ${runId} is in unsupported state ${current.state}.`));
  return withWorkflowPolicy(buildRunnerReport({
    registryRoot,
    runId,
    previousState,
    currentState: current.state,
    outcome: "blocked",
    stepsTaken,
    blockers,
    warnings,
    workspacePreparation,
    implementationDispatch,
    verification,
    internalReview,
  }));
}


const RUN_LOOP_TERMINAL_OUTCOMES = new Set(["blocked", "failed", "waiting"]);

function mergeRunnerReports(previous, next) {
  if (!previous) return next;
  return {
    ...next,
    previous_state: previous.previous_state || next.previous_state,
    steps_taken: [...(previous.steps_taken || []), ...(next.steps_taken || [])],
    blockers: [...(previous.blockers || []), ...(next.blockers || [])],
    warnings: [...(previous.warnings || []), ...(next.warnings || [])],
    workspace_preparation: next.workspace_preparation || previous.workspace_preparation || null,
    implementation_dispatch: next.implementation_dispatch || previous.implementation_dispatch || null,
    verification: next.verification || previous.verification || null,
    internal_review: next.internal_review || previous.internal_review || null,
    fix_loop: next.fix_loop || previous.fix_loop || null,
    projection: next.projection || previous.projection || null,
  };
}

export async function runLocalMission(options = {}) {
  const maxRunnerSteps = Number.isSafeInteger(options.maxRunnerSteps) && options.maxRunnerSteps > 0 ? options.maxRunnerSteps : 1;
  let aggregate = null;
  let lastState = "";

  for (let step = 0; step < maxRunnerSteps; step += 1) {
    const report = await runLocalMissionStep(options);
    aggregate = mergeRunnerReports(aggregate, report);

    if (RUN_LOOP_TERMINAL_OUTCOMES.has(report.outcome)) return aggregate;
    if (!report.current_state || report.current_state === lastState) return aggregate;
    lastState = report.current_state;
    if (["ready_for_manual_review", "failed_execution", "blocked_needs_human"].includes(report.current_state)) return aggregate;
  }

  if (maxRunnerSteps <= 1) return aggregate;
  return {
    ...aggregate,
    outcome: "waiting",
    warnings: [
      ...(aggregate?.warnings || []),
      buildIssue("bounded_run_loop_budget_exhausted", `Bounded run loop stopped after ${maxRunnerSteps} deterministic steps; reinvoke /buran run to continue.`, { max_runner_steps: maxRunnerSteps }),
    ],
  };
}
