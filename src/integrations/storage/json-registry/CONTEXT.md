# JSON registry storage integration

Owns concrete JSON files, path layout, atomic writes, event journals, indexes, snapshots, artifacts, recovery reports, quarantine moves, and lease-record files. It must preserve the durable registry format exposed by the execution-runs and workspace-leases core ports.

This subtree owns storage persistence semantics. Worktree services may call the lease-record port, but they must not redefine how lease records are stored.

## WorkerTask persistence

The JSON registry adapter persists worker task events and `run.json.worker_tasks` snapshots through repository/store methods only. It appends worker task events before snapshot writes, preserves idempotency, and must quarantine or reject conflicting idempotency payloads instead of silently advancing run truth. Lifecycle legality remains in execution-run core.

## WorkerTask lifecycle note

Issue #16 adds durable implementation/fix worker lifecycle tracking. Core owns WorkerTask and CompletionDecision semantics; application code sequences lifecycle writes; JSON registry persists and replays them; observability/reporting must expose only sanitized worker summaries and safe artifact refs.
