# Application context

Owns thin use-case orchestration only. It may sequence core contexts and injected adapters, but must not own durable schema rules, registry storage format, provider transport details, or worker execution.
