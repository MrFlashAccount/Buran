#!/usr/bin/env node
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
