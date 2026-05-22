import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { resolveRecordedArtifactPath } from "../src/application/recorded-artifacts.js";

test("recorded artifact resolver rejects absolute paths, outside paths, and traversal segments", () => {
  const runDir = path.resolve("/tmp/buran-run");

  assert.equal(resolveRecordedArtifactPath(runDir, "/tmp/buran-run/artifacts/result.json"), null);
  assert.equal(resolveRecordedArtifactPath(runDir, "C:\\buran-run\\artifacts\\result.json"), null);
  assert.equal(resolveRecordedArtifactPath(runDir, "../outside.json"), null);
  assert.equal(resolveRecordedArtifactPath(runDir, "artifacts/../run.json"), null);
  assert.equal(resolveRecordedArtifactPath(runDir, "artifacts\\..\\run.json"), null);

  assert.deepEqual(resolveRecordedArtifactPath(runDir, "artifacts/result.json"), {
    absolutePath: path.join(runDir, "artifacts/result.json"),
    relativePath: "artifacts/result.json",
  });
});
