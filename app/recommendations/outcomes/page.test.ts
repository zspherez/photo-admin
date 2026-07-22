import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

test("post-show outcomes are authenticated and preserve exact attribution", () => {
  const page = source("app/recommendations/outcomes/page.tsx");
  assert.match(page, /requireServerActionAuth\("\/recommendations\/outcomes"\)/);
  assert.match(page, /ready, stale, and superseded runs/);
  assert.match(page, /recommendation\.producerRunId/);
  assert.match(page, /recommendation\.id/);
  assert.match(page, /RecommendationFeedbackPanel/);
  assert.match(page, /returnTo=\{returnTo\}/);
  assert.match(page, /outcomeOnly/);
});
