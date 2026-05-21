# JSON registry storage integration

Owns concrete JSON files, path layout, atomic writes, event journals, indexes, snapshots, artifacts, recovery reports, quarantine moves, and lease-record files. It must preserve the durable registry format exposed by the execution-runs and workspace-leases core ports.

This subtree owns storage persistence semantics. Worktree services may call the lease-record port, but they must not redefine how lease records are stored.
