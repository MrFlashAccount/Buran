# Filesystem worktree integration

Owns concrete local workspace/worktree behavior: filesystem locks orchestration, workspace preparation inspection, git/status facts, and recovery of workspace lease state.

Provider-neutral lease semantics live in `workspace-leases/contract.js`. Durable lease-record file semantics live in `integrations/storage/json-registry`; this worktree layer may use the lease-record port but should not own JSON-registry persistence rules.
