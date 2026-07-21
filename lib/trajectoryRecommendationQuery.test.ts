import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecommendationHref,
  parseRecommendationQuery,
  recommendationDateRange,
  RECOMMENDATION_DATE_BANDS,
  RECOMMENDATION_TABS,
  RECOMMENDATION_WORKFLOWS,
} from "./trajectoryRecommendationQuery";

test("every recommendation tab, workflow filter, and date band is URL-backed", () => {
  for (const tab of RECOMMENDATION_TABS) {
    assert.equal(parseRecommendationQuery({ tab }).tab, tab);
  }
  for (const workflow of RECOMMENDATION_WORKFLOWS) {
    assert.equal(parseRecommendationQuery({ workflow }).workflow, workflow);
  }
  for (const date of RECOMMENDATION_DATE_BANDS) {
    assert.equal(parseRecommendationQuery({ date }).dateBand, date);
  }
  assert.equal(
    buildRecommendationHref({
      tab: "portfolio",
      workflow: "direct",
      dateBand: "45-90",
    }),
    "/recommendations?tab=portfolio&workflow=direct&date=45-90",
  );
});

test("invalid recommendation filters fail closed to documented defaults", () => {
  assert.deepEqual(
    parseRecommendationQuery({
      tab: "admin",
      workflow: "send",
      date: "0-365",
    }),
    { tab: "suggested", workflow: "all", dateBand: "all" },
  );
});

test("date bands enforce the five-day minimum with non-overlapping boundaries", () => {
  const now = new Date("2026-07-21T16:00:00.000Z");
  const minimum = new Date("2026-07-20T00:00:00.000Z");
  assert.deepEqual(recommendationDateRange("5-10", now, minimum), {
    start: new Date("2026-07-26T00:00:00.000Z"),
    endExclusive: new Date("2026-07-31T00:00:00.000Z"),
  });
  assert.deepEqual(recommendationDateRange("10-45", now, minimum), {
    start: new Date("2026-07-31T00:00:00.000Z"),
    endExclusive: new Date("2026-09-04T00:00:00.000Z"),
  });
  assert.deepEqual(recommendationDateRange("45-90", now, minimum), {
    start: new Date("2026-09-04T00:00:00.000Z"),
    endExclusive: new Date("2026-10-20T00:00:00.000Z"),
  });
});

test("the producer minimum show date can only move the lower bound later", () => {
  const range = recommendationDateRange(
    "all",
    new Date("2026-07-21T16:00:00.000Z"),
    new Date("2026-08-01T00:00:00.000Z"),
  );
  assert.equal(range.start.toISOString(), "2026-08-01T00:00:00.000Z");
});
