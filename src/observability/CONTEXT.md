# Observability context

Owns privacy-safe redaction, diagnostics, public report summaries, and path sanitization. It must not expose prompts, raw packet text, transcripts, stdout/stderr, secrets, or local absolute paths in public output.

## WorkerTask summaries

Observability may derive `WorkerTaskSummary` from registry/domain truth only. Public output may include task id, status, decision, safe artifact refs, overdue/conflict flags, and next-safe-action text, but never raw worker prompts, transcripts, stdout/stderr, file contents, session blobs, or raw completion bodies.

## WorkerTask lifecycle note

Issue #16 adds durable implementation/fix worker lifecycle tracking. Core owns WorkerTask and CompletionDecision semantics; application code sequences lifecycle writes; JSON registry persists and replays them; observability/reporting must expose only sanitized worker summaries and safe artifact refs.
