# buran Context

## Purpose

This folder owns the narrow plugin that executes manually approved GitHub implementation packets through local JSON-tracked runs, verification, internal review, PR creation, and `Ready for Manual Review` handoff.

## Owning context

Owner: `ExecutionRun` lifecycle.

This context starts after external research/planning approval and ends before human PR review/merge.

## Language

- **Approved packet**: sufficient manual implementation packet created outside this plugin.
- **ExecutionRun**: one durable local run record.
- **Gate**: verification or internal review result that must pass before PR creation.
- **Projection**: remote GitHub/TaskFlow/comment/project update derived from local JSON.
- **Workspace lease**: lock over workspace/repo/issue/branch/conflict surface.

## Belongs here

- Local run registry schema and lifecycle rules.
- Packet sufficiency validation.
- Workspace scheduling and lock semantics.
- Implementation execution inside an approved packet envelope.
- Verification and internal review gate orchestration.
- PR creation only after gates pass.
- GitHub/TaskFlow/comment/project projection adapters.
- Recovery and projection repair from local JSON state.

## Does not belong here

- Research, planning, architecture drafting, or implementation packet creation.
- Backlog intake, prioritization, or task discovery.
- PR babysitting after `Ready for Manual Review`.
- Dashboard UI.
- Auto-merge or Done automation.
- Generic queue ownership unrelated to approved GitHub task execution.

## Allowed relationships

- May read approved packets supplied by an operator or upstream manual process.
- May write local run state under the plugin's registry/artifact layout.
- May create/update GitHub PRs, comments, labels, and project fields as projections from local state.
- May use git/workspace/test/review adapters behind explicit ports.
- May inspect legacy/reference code only to inform migration or adapter design.

## Forbidden dependencies

- Do not depend on `plugins/background-worker` as the execution owner.
- Do not depend on `scripts/github-*queue` as canonical state.
- Do not treat GitHub, TaskFlow, comments, labels, or project fields as source of truth.
- Do not create a global lock that serializes all runs.
- Do not bypass verification or internal review gates for PR creation.
- Do not improvise missing architecture or scope when a packet is insufficient.

## Placement rules

- Domain transition rules stay separate from effectful adapters.
- JSON schema and state-machine changes must be documented in `docs/` before implementation changes rely on them.
- Projection behavior belongs behind projection contracts, not scattered through workflow code.
- Source-tree ownership changes should update `docs/module-map.md`.
- Boundary or handoff changes should update `docs/context-map.md`.
- Legacy/reference behavior must be copied only through explicit migration slices, not by quiet coupling.
