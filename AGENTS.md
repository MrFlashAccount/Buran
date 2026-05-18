# AGENTS.md

Small, privacy-safe guide for future agents working in this repo.

## What this repo is

Buran is a local JSON-first OpenClaw plugin for executing already approved GitHub implementation packets. It owns local run state, gates, and PR handoff recording. It does not own planning, discovery, or merge automation.

Start here:

- `README.md` — current scope, commands, config, and packet sufficiency rules
- `ARCHITECTURE.md` — selected architecture and binding rules
- `CONTEXT.md` — what belongs in this repo and what does not

## Fast navigation

Docs:

- `docs/context-map.md` — upstream/downstream boundaries and handoff points
- `docs/module-map.md` — source-tree responsibilities by file
- `docs/state-machine.md` — run lifecycle and transition rules
- `docs/execution-run-schema.md` — registry layout, event types, recovery contract
- `docs/github-projection-contract.md` — PR/projection semantics
- `docs/acceptance-scenarios.md` — scenario-level summary of the tested slice
- `docs/migration-plan.md` — migration notes from legacy/reference surfaces
- `docs/observability.md` — logs, diagnostics, and redaction boundary

Runtime/code:

- `openclaw.plugin.json` — plugin manifest and config schema
- `package.json` — package metadata and maintainer scripts
- `index.js` — plugin export surface
- `bin/buran.js` — CLI entrypoint
- `src/` — implementation modules
- `test/` — automated coverage and fixtures

## Package scripts and checks

Use the repo scripts before claiming success:

- `npm test` — runs `node --test test/*.test.js`
- `npm run check` — imports plugin entrypoint, verifies ignore rules, and syntax-checks `index.js`, `src/`, `bin/`, and `test/`

## Source layout

Use `docs/module-map.md` for the detailed file map. Quick landmarks:

- `src/buran.js` and `src/cli.js` — validate/intake/CLI flow
- `src/runner.js` — local mission runner orchestration
- `src/registry-store.js` and `src/execution-run-schema.js` — canonical persistence contract
- `src/locks.js` — lease/conflict logic
- `src/verification-adapter.js` and `src/internal-review-adapter.js` — gate adapters
- `src/pr-projection-adapter.js` and `src/github-pr-transport-adapter.js` — PR handoff/projection logic
- `src/recovery.js` — replay, quarantine, and rebuild flow

## Working rules

- Keep repo docs privacy-safe. No personal names, local machine paths, tokens, or secret-like identifiers in docs meant for handoff.
- Treat local registry state as source of truth. Remote systems are projections.
- Do not widen scope: weak packets block, they are not completed by guesswork.
- Keep docs aligned with code. If you change ownership, flow, schema, or boundaries, update the matching docs in the same change.
- Prefer the narrowest correct change. This repo is intentionally bounded.

## When changing docs or behavior

Update the relevant docs together:

- lifecycle/state changes -> `docs/state-machine.md`
- persisted shape or event changes -> `docs/execution-run-schema.md`
- boundary/handoff changes -> `docs/context-map.md` and `CONTEXT.md`
- source ownership/layout changes -> `docs/module-map.md`
- user-facing scope/commands/config changes -> `README.md`

## Before finishing

Minimum gate:

1. run a privacy search over changed handoff docs
2. run `npm test`
3. run `npm run check`
4. verify links/paths in docs point to real repo files
