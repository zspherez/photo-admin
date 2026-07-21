import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { encodeRecommendationCursor } from "@/lib/trajectoryRecommendationCursor";
import {
  handleRecommendationBatchRequest,
  parseRecommendationBatchRequest,
} from "./route";

const ownerKey = "a".repeat(64);
const now = new Date("2026-07-21T16:00:00.000Z");
const query = {
  tab: "suggested",
  workflow: "all",
  dateBand: "all",
} as const;
const cursor = encodeRecommendationCursor("run_1", 48, query, ownerKey);

function dependencies(
  overrides: Partial<
    NonNullable<Parameters<typeof handleRecommendationBatchRequest>[1]>
  > = {},
): NonNullable<Parameters<typeof handleRecommendationBatchRequest>[1]> {
  return {
    authenticate: async () => ({ status: "ok", ownerKey }),
    now: () => now,
    loadPage: async () => ({
      availability: "ready",
      run: {
        id: "run_1",
        generatedAt: now.toISOString(),
        asOfDate: "2026-07-20",
        decisionDate: "2026-07-21",
        minimumShowDate: "2026-07-26",
        validUntil: "2026-07-25T00:00:00.000Z",
        modelStatus: "provisional_population_matched_event_momentum",
        status: "ready",
        failureCode: null,
        failureMessage: null,
        freshness: "fresh",
      },
      recommendations: [],
      total: 0,
      nextOffset: null,
    }),
    ...overrides,
  };
}

test("recommendation batch API authenticates before reading model data", async () => {
  let loaded = false;
  const response = await handleRecommendationBatchRequest(
    new NextRequest(
      `https://example.test/api/recommendations?cursor=${cursor}`,
    ),
    dependencies({
      authenticate: async () => ({ status: "unauthorized" }),
      loadPage: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    }),
  );
  assert.equal(response.status, 401);
  assert.equal(loaded, false);
});

test("recommendation batch API rejects unknown, duplicate, and invalid filters", async () => {
  for (const url of [
    `https://example.test/api/recommendations?cursor=${cursor}&admin=true`,
    `https://example.test/api/recommendations?cursor=${cursor}&cursor=again`,
    `https://example.test/api/recommendations?cursor=${cursor}&tab=admin`,
    `https://example.test/api/recommendations?cursor=${cursor}&workflow=send`,
    `https://example.test/api/recommendations?cursor=${cursor}&date=365`,
  ]) {
    const response = await handleRecommendationBatchRequest(
      new NextRequest(url),
      dependencies(),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(
    parseRecommendationBatchRequest(
      new URL(
        `https://example.test/api/recommendations?cursor=${cursor}&tab=suggested`,
      ),
    )?.query.tab,
    "suggested",
  );
});

test("recommendation batch API refuses stale or superseded run cursors", async () => {
  const response = await handleRecommendationBatchRequest(
    new NextRequest(
      `https://example.test/api/recommendations?cursor=${cursor}`,
    ),
    dependencies({
      loadPage: async () => ({
        availability: "superseded",
        run: null,
        recommendations: [],
        total: 0,
        nextOffset: null,
      }),
    }),
  );
  assert.equal(response.status, 410);
});

test("recommendation batch API carries the exact cursor run into the read", async () => {
  let expectedRunId = "";
  let offset = -1;
  const response = await handleRecommendationBatchRequest(
    new NextRequest(
      `https://example.test/api/recommendations?cursor=${cursor}`,
    ),
    dependencies({
      loadPage: async (_query, options) => {
        expectedRunId = options?.expectedRunId ?? "";
        offset = options?.offset ?? -1;
        return {
          ...(await dependencies().loadPage(_query, options)),
          nextOffset: 96,
        };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(expectedRunId, "run_1");
  assert.equal(offset, 48);
  const body = await response.json();
  assert.equal(typeof body.nextCursor, "string");
});
