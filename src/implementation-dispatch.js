import { canonicalJson, nonEmptyString, sha256Hex } from "./utils.js";

const DISPATCH_STATUS = "dispatch_not_started";
const DISPATCH_SCHEMA_VERSION = "implementation-dispatch-intent.v1";

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
      reason: "local_runner_dispatch_not_implemented",
    },
  };

  const dispatchIntentId = sha256Hex(canonicalJson(intent));
  return {
    intent: {
      ...intent,
      dispatch_intent_id: dispatchIntentId,
    },
    artifactPath: `artifacts/implementation-dispatch/${dispatchIntentId.slice(0, 16)}.json`,
  };
}
