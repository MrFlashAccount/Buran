import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { verifyArtifactRefs } from "../src/execution-runs/recovery/index.js";

const SHA = "a".repeat(64);

function snapshotWithRecordedPath(artifactPath) {
  return {
    artifacts: {
      recorded: {
        by_path: {
          [artifactPath]: { path: artifactPath, sha256: SHA },
        },
      },
    },
  };
}

test("recovery artifact verification rejects unsafe recorded artifact paths", async () => {
  const runDir = path.resolve("/tmp/buran-run");
  const unsafePaths = ["artifacts/../run.json", "artifacts\\..\\run.json", "../escape", "/tmp/run.json", "C:\\buran\\run.json"];
  const store = {
    async readArtifactContent() {
      throw new Error("unsafe paths must not be read");
    },
  };

  for (const unsafePath of unsafePaths) {
    const findings = await verifyArtifactRefs(store, runDir, snapshotWithRecordedPath(unsafePath), []);
    assert.deepEqual(findings, [{ severity: "error", type: "artifact_path_escape", path: unsafePath }]);
  }
});
