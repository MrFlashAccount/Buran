/** Recovery public report formatting helpers. */

/**
 * Formats a compact human-readable recovery summary.
 *
 * @param {Record<string, unknown>} report
 * @returns {string}
 */
export function formatRecoveryReport(report) {
  const lines = [];
  lines.push("buran: recovery");
  lines.push(`Registry: ${report.registry_root}`);
  lines.push(`Runs: inspected=${report.summary.inspected_runs}; valid=${report.summary.valid_runs}; quarantined=${report.summary.quarantined_runs}`);
  lines.push(`Findings: ${report.summary.findings}`);
  lines.push(`Active index: ${report.summary.active_runs}; workspace leases=${report.summary.workspace_leases}`);
  lines.push("External side effects: no");
  for (const quarantine of report.quarantined) {
    lines.push(`- quarantined ${quarantine.run_id}: ${quarantine.reason} -> ${quarantine.quarantine_dir}`);
  }
  for (const finding of report.findings.filter((entry) => entry.type !== "quarantined_run")) {
    lines.push(`- finding ${finding.run_id || "registry"}: ${finding.type}`);
  }
  return lines.join("\n");
}
