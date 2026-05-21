# Observability contract

Buran keeps three local evidence surfaces with different authority:

1. **Durable execution journal** (`registry/runs/<run_id>/events.jsonl` + `run.json` in the current JSON storage adapter): source of truth for run state, transitions, leases, quarantine, and recovery. See [execution-run-schema.md](./execution-run-schema.md).
2. **Operational logs** (`.openclaw-runtime/plugins/buran/logs/operational.jsonl` by default): JSONL diagnostics for CLI/plugin invocations. Best-effort breadcrumbs only.
3. **Diagnostic reports** (`.openclaw-runtime/plugins/buran/diagnostics/<trace_id>.json` by default): one bounded summary per invocation, with outcome, duration, reason, and sanitized errors.

There is no external telemetry. These files stay local and ignored by git.

## Operational log schema

Each JSONL record uses `observability.v1`.

Typical fields:

- `schema_version`
- `timestamp`
- `level`
- `component`
- `event`
- `trace_id`
- `batch_id` / `run_id` when available
- `outcome`
- `reason`
- `error_kind`
- `duration_ms`
- `context`

### Event vocabulary

Current emitted event names are:

- `cli.invocation.started`
- `cli.command.parsed`
- `cli.invocation.rejected`
- `cli.invocation.completed`
- `cli.invocation.failed`
- `validation.completed`
- `intake.completed`
- `runner.completed`
- `recovery.completed`
- `lease.acquire.completed`
- `lease.release.completed`
- `diagnostic.report_written`

`runner.completed` is the success marker for `/buran run`.

Limitation: the logger does not preserve arbitrary custom event names. Anything outside this allowlist is folded into `diagnostic.report_written`, so new event names should be added deliberately and covered by tests.

## Trace correlation

Every invocation gets one `trace_id`. Public outputs point to:

- `trace_id`
- `log_path`
- `diagnostic_report_path`

When available, logs also carry `batch_id` and/or `run_id` so operators can jump from a trace to the registry journal.

## Runner breadcrumbs

The local runner returns a report with `steps_taken` plus stage summaries like:

- `workspace_preparation`
- `implementation_dispatch`
- `verification`
- `internal_review`
- `projection`

`steps_taken` is an operational breadcrumb trail only. Durable truth still lives in the registry snapshot and event journal (`registry/runs/<run_id>/run.json` and `registry/runs/<run_id>/events.jsonl` in the current JSON storage adapter); the exact event and snapshot contract is documented in [execution-run-schema.md](./execution-run-schema.md).

Common breadcrumb actions include `lease_acquire`, `workspace_preparation`, `implementation_dispatch`, `verification_artifact`, `gate_result_recorded`, `verification_resume`, `internal_review_artifact`, `internal_review_resume`, `projection_intent_recorded`, `projection_result_recorded`, and `transition`.

## Sanitization and redaction

Sanitization is layered and path-aware.

### Path handling

Known roots are replaced with labels such as `<observability>`, `<state>`, `<workspace>`, `<registry>`, and `<packet_list>`.

For absolute paths outside known roots:

- keep only a safe basename when possible: `/tmp/foo/bar.js` → `<absolute_path>/bar.js`
- drop the basename entirely when it looks secret-like or path-like: `/Users/user/private/subpath` → `<absolute_path>`
- preserve ordinary relative text and URLs unchanged

### Secret and raw-content handling

Operational logs and diagnostic reports redact:

- secret-like keys such as `token`, `secret`, `password`, `authorization`, API keys, cookies, and credentials;
- raw content keys such as `raw`, `raw_packet`, `packet`, `packets`, `document`, `documents`, `body`, `content`, `markdown`, `user_doc`, `user_docs`;
- secret-like string values such as `github_pat_...`, `ghp_...`, `glpat-...`, `sk-...`, bearer tokens, and similar;
- long strings, arrays, and deep object graphs.

Public CLI output uses the same path redaction rules and a narrower field redaction pass for report payloads.

## Runtime logger boundary

If the embedding runtime provides `api.logger` (as OpenClaw does in the current profile), the plugin mirrors sanitized operational events there on a best-effort basis. Local JSONL logging and diagnostic report creation do not depend on that mirror.
