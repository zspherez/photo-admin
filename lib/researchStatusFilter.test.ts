import assert from "node:assert/strict";
import test from "node:test";
import {
  parseResearchStatusFilter,
  researchStatusCounts,
  researchStatusFilterDefinition,
  researchStatusHref,
} from "./researchStatusFilter";

test("research status filter parsing accepts known values and falls back to all", () => {
  assert.equal(parseResearchStatusFilter("review"), "review");
  assert.equal(parseResearchStatusFilter(["complete", "pending"]), "complete");
  assert.equal(parseResearchStatusFilter("skipped"), "skipped");
  assert.equal(parseResearchStatusFilter("invalid"), "all");
  assert.equal(parseResearchStatusFilter(undefined), "all");
});

test("research status definitions keep URL state data driven", () => {
  assert.deepEqual(researchStatusFilterDefinition("pending").statuses, [
    "pending",
  ]);
  assert.deepEqual(researchStatusFilterDefinition("all").statuses, [
    "review",
    "claimed",
    "pending",
    "complete",
    "exhausted",
  ]);
  assert.deepEqual(researchStatusFilterDefinition("skipped").statuses, [
    "skipped",
  ]);
});

test("research status counts remain based on the full queue", () => {
  const counts = researchStatusCounts([
    { status: "review", count: 3 },
    { status: "claimed", count: 2 },
    { status: "pending", count: 7 },
    { status: "complete", count: 11 },
    { status: "exhausted", count: 5 },
    { status: "skipped", count: 4 },
    { status: "inactive", count: 100 },
  ]);

  assert.equal(counts.get("review"), 3);
  assert.equal(counts.get("complete"), 11);
  assert.equal(counts.get("skipped"), 4);
  assert.equal(counts.get("all"), 28);
});

test("research status links preserve the active filter with result state", () => {
  assert.equal(researchStatusHref("all"), "/research?status=all");
  assert.equal(
    researchStatusHref("exhausted", {
      error: "retry_failed",
      detail: "Try again",
    }),
    "/research?status=exhausted&error=retry_failed&detail=Try+again"
  );
});
