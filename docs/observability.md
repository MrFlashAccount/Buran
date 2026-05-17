# Observability contract

Buran keeps three local evidence surfaces with different authority:

1. **Durable execution journal** (`registry/runs/<run_id>/events.jsonl` plus `run.json`): the source of truth for run state, transitions, leases, quarantine, and recovery. Reviewers must use this registry data for state decisions.
2. **Operational logs** (`.openclaw-runtime/plugins/buran/logs/operational.jsonl` by default): local JSONL diagnostics for debugging CLI/plugin invocations. Logs are append-only best-effort breadcrumbs, not a source of truth.
3. **Diagnostic reports** (`.openclaw-runtime/plugins/buran/diagnostics/<trace_id>.json` by default): one bounded summary per CLI/plugin invocation. Reports point to the trace/log path and summarize outcome, duration, reason, and sanitized errors. They complement recovery reports; they do not replace registry events or `indexes/recovery-report.json`.

There is no external telemetry. All observability output is local runtime state and must remain ignored by git.

## Operational log schema

Each JSONL record uses `observability.v1`:

```json
{
  "schema_version": "observability.v1",
  "timestamp": "2026-05-16T20:04:00.000Z",
  "level": "info",
  "component": "cli",
  "event": "intake.completed",
  "trace_id": "trace_20260516200400_abc123def456",
  "batch_id": "batch_...",
  "run_id": "run_...",
  "outcome": "success",
  "reason": "",
  "error_kind": "",
  "duration_ms": 12,
  "context": {}
}
```

Bounded event names currently emitted:

- `cli.invocation.started`
- `cli.command.parsed`
- `cli.invocation.rejected`
- `cli.invocation.completed`
- `cli.invocation.failed`
- `validation.completed`
- `intake.completed`
- `recovery.completed`
- `lease.acquire.completed`
- `lease.release.completed`
- `diagnostic.report_written`

## Trace correlation

Every CLI/plugin invocation gets one `trace_id`. Reports include:

- `trace_id`
- `log_path`
- `diagnostic_report_path`

When available, operational log events also include `batch_id` and/or `run_id` so operators can jump from a trace to the durable registry.

## Sanitization and redaction

Operational logs and diagnostic summaries must not include raw packet bodies, raw user documents, secrets, tokens, authorization headers, or full private home paths. The sanitizer:

- redacts secret-like keys (`token`, `secret`, `password`, `authorization`, API keys, cookies, credentials);
- redacts raw content keys (`raw`, `body`, `content`, `document`, `packet`, `packets`);
- redacts common secret-like string values (`github_pat_...`, `ghp_...`, `sk-...`, bearer tokens, Slack-style tokens);
- replaces `/Users/<name>` style home prefixes with `~` in log strings;
- bounds long strings, arrays, and object depth.

The durable registry may still store approved packet artifacts by design. That registry is the source of truth and is separate from operational logging.

## Runtime logger boundary

If the OpenClaw plugin runtime provides `api.logger`, the plugin mirrors sanitized operational events to it on a best-effort basis at the adapter boundary only. Local JSONL logging and diagnostic report creation do not depend on runtime logger availability, and mirror failures are ignored.
