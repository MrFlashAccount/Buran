#!/usr/bin/env node
/**
 * CLI executable boundary for invoking Buran from a local shell.
 *
 * Responsibilities:
 * - translate Node process argv into {@link runBuranCli} input;
 * - print the human-facing CLI result to stdout/stderr;
 * - preserve sanitized failures so local callers do not see raw secrets or paths.
 *
 * Non-goals:
 * - no argument parsing logic beyond forwarding argv;
 * - no registry or runner orchestration outside the core CLI module.
 *
 * Side effects:
 * - writes to process stdout/stderr;
 * - sets {@link process.exitCode} instead of forcing an immediate exit.
 */
import { runBuranCli } from "../src/cli.js";
import { sanitizeError } from "../src/observability.js";

try {
  const result = await runBuranCli(process.argv.slice(2));
  process.stdout.write(`${result.text}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const publicMessage = error?.publicMessage || error?.publicError?.message || sanitizeError(error).message || "Command failed";
  process.stderr.write(`${publicMessage}\n`);
  process.exitCode = 1;
}
