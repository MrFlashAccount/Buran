# Execution runs context

Owns durable provider-neutral run state language: schema, state machine, recovery policy, `work_item`, `scm_target`, `handoff_target`, `projection_ledger`, and registry API contract. Concrete JSON/filesystem persistence lives under `integrations/storage/json-registry/`.
