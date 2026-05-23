import assert from "node:assert/strict";
import { test } from "node:test";

import { appendScmHandoffTargetValidationErrors, isValidProjectionUrl } from "../src/core/modules/scm-handoff/contract.js";

test("provider-neutral SCM handoff core accepts non-GitHub http handoff URLs", () => {
  assert.equal(isValidProjectionUrl("https://gitlab.example.com/group/project/-/merge_requests/42"), true);
  assert.equal(isValidProjectionUrl("https://github.example.com/org/repo/pull/42"), true);
  assert.equal(isValidProjectionUrl("ftp://gitlab.example.com/group/project/-/merge_requests/42"), false);

  const errors = [];
  appendScmHandoffTargetValidationErrors({
    number: 42,
    url: "https://gitlab.example.com/group/project/-/merge_requests/42",
    repo: "group/project",
    issue_number: null,
    head_branch: "feature/scm-neutral",
    base_branch: "main",
    state: "opened",
    draft: false,
    title: "Provider-neutral handoff",
  }, errors);

  assert.deepEqual(errors, []);
});
