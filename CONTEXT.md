# buran Context

## Purpose

This folder owns the narrow plugin that executes manually approved `work_item` packets through provider-neutral run state, verification, internal review, `handoff_target` projection, and `Ready for Manual Review` handoff. The current OpenClaw/GitHub/JSON path is an adapter/profile, not core ownership.

## Owning context

Owner: `ExecutionRun` lifecycle.

This context starts after external research/planning approval and ends before human review/merge. In the current GitHub profile, that review target is a PR.

## Language

- **work_item**: sufficient manual implementation packet created outside this plugin.
- **scm_target**: provider-neutral repository/review target used for locks and handoff.
- **ExecutionRun**: one durable local run record.
- **Gate**: verification or internal review result that must pass before handoff projection.
- **projection_ledger**: provider-specific update intent/result derived from local registry state.
- **handoff_target**: configured review destination after local gates pass.
- **Workspace lease**: lock over workspace/repo checkout/`scm_target`/branch/conflict surface.

## Belongs here

- Provider-neutral run registry contract and lifecycle rules.
- Packet sufficiency validation.
- Workspace scheduling and lock semantics.
- Implementation execution inside an approved packet envelope.
- Verification and internal review gate orchestration.
- Handoff projection only after gates pass.
- Provider-specific SCM/tracker/review projection adapters.
- Recovery and projection repair from local registry state.

## Does not belong here

- Research, planning, architecture drafting, or implementation packet creation.
- Backlog intake, prioritization, or `work_item` discovery.
- Handoff babysitting after `Ready for Manual Review`.
- Dashboard UI.
- Auto-merge or Done automation.
- Generic queue ownership unrelated to approved `work_item` execution.

## Allowed relationships

- May read approved packets supplied by an operator or upstream manual process.
- May write local run state through the registry port and current registry/artifact layout.
- May create/update provider-specific handoff and tracker surfaces as projections from local state.
- May use SCM/workspace/test/review adapters behind explicit ports.
- May inspect legacy/reference code only to inform migration or adapter design.

## Forbidden dependencies

- Do not depend on `plugins/background-worker` as the execution owner.
- Do not depend on `scripts/github-*queue` as canonical state.
- Do not treat GitHub, TaskFlow, comments, labels, project fields, or any remote provider state as source of truth.
- Do not create a global lock that serializes all runs.
- Do not bypass verification or internal review gates for handoff projection.
- Do not improvise missing architecture or scope when a packet is insufficient.

## Placement rules

- Domain transition rules stay separate from effectful adapters.
- Registry schema and state-machine changes must be documented in `docs/` before implementation changes rely on them.
- Projection behavior belongs behind projection contracts, not scattered through workflow code.
- Source-tree ownership changes should update `docs/module-map.md`.
- Boundary or handoff changes should update `docs/context-map.md`.
- Legacy/reference behavior must be copied only through explicit migration slices, not by quiet coupling.

## WorkerTask placement

`ExecutionRun` owns worker-task truth: lifecycle vocabulary, identity, completion legality, and the relationship between accepted completions and outer run transitions. Application code may sequence dispatch/completion ingestion through the registry port, but must not define canonical worker lifecycle rules. Integrations submit and persist evidence through seams only; summaries and recovery reports must stay sanitized and must not expose raw prompts, transcripts, stdout/stderr, session blobs, or raw completion payloads.

## WorkerTask lifecycle note

Issue #16 adds durable implementation/fix worker lifecycle tracking. Core owns WorkerTask and CompletionDecision semantics; application code sequences lifecycle writes; JSON registry persists and replays them; observability/reporting must expose only sanitized worker summaries and safe artifact refs.
