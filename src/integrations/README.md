# Integrations boundary

`src/integrations` contains concrete adapters for core ports. Core modules own contracts and business rules; integrations own the local or external IO needed to satisfy those contracts.

## Storage: `storage/json-registry`

Owns durable JSON persistence for the local registry:

- run snapshots and event journals;
- derived indexes and registry reports;
- recorded artifacts and projection intent/result payloads;
- lease-record files under the registry lease-record layout.

Adapters in this subtree implement storage-facing ports such as the execution-run registry repository, lease-record store, and registry recovery store. They define file layout, atomic write behavior, quarantine/report writes, and JSON read/write semantics.

## Worktree: `worktree/filesystem`

Owns local workspace/worktree behavior:

- workspace lease orchestration over local workspaces;
- conflict inspection using active run snapshots plus lease records;
- git/status/preparation inspection and filesystem facts needed before execution.

The filesystem worktree lease service may use the JSON-registry lease-record port to create/remove durable lock files, but it should not own the storage persistence semantics for those files. Persistence rules stay in `storage/json-registry`; workspace behavior stays in `worktree/filesystem`.

## SCM: `scm/*`

SCM integrations project provider-neutral handoff plans/results into concrete SCM transports. For example, the GitHub integration uses the noninteractive `gh` CLI to create or update pull requests only after local master-workflow evidence has passed validation.

`integration.js` provides a lightweight descriptor for composition/debug visibility. It is metadata, not a required superclass for adapters.
