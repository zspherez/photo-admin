import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRecommendationCursor,
  encodeRecommendationCursor,
  verifyRecommendationCursor,
} from "./trajectoryRecommendationCursor";

const key = "a".repeat(64);
const query = {
  tab: "trajectory",
  workflow: "ready",
  dateBand: "10-45",
} as const;

test("recommendation cursors bind run, offset, filters, and authenticated scope", () => {
  const encoded = encodeRecommendationCursor("run_1", 48, query, key);
  const decoded = decodeRecommendationCursor(encoded, query);
  assert.deepEqual(decoded, {
    runId: "run_1",
    offset: 48,
    signature: decoded?.signature,
  });
  assert.ok(decoded);
  assert.equal(verifyRecommendationCursor(decoded, query, key), true);
  assert.equal(
    decodeRecommendationCursor(encoded, { ...query, workflow: "clicked" }),
    null,
  );
  assert.equal(
    verifyRecommendationCursor(decoded, query, "b".repeat(64)),
    false,
  );
});

test("recommendation cursors reject malformed and non-canonical input", () => {
  assert.equal(decodeRecommendationCursor("", query), null);
  assert.equal(decodeRecommendationCursor("***", query), null);
  assert.throws(() =>
    encodeRecommendationCursor("run_1", -1, query, key),
  );
});
