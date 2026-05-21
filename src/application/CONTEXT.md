# Application context

Owns thin use-case orchestration only. It may sequence core contexts and injected adapters, but must not own durable schema rules, concrete registry storage format, provider transport details, or worker execution. Dependencies are injected at startup/composition root.
