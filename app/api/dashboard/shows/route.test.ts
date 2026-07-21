import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  handleDashboardShowsRequest,
  parseDashboardBatchRequest,
} from "./route";

const now = new Date("2026-07-20T22:00:00.000Z");
const emptyBatch = {
  shows: [],
  nextCursor: null,
  snapshotAt: now,
};

function dependencies(
  overrides: Partial<
    NonNullable<Parameters<typeof handleDashboardShowsRequest>[1]>
  > = {}
): NonNullable<Parameters<typeof handleDashboardShowsRequest>[1]> {
  return {
    authenticate: async () => "ok",
    loadBatch: async () => emptyBatch,
    loadInteractionState: async () => ({
      sendabilityRows: [],
      followUpEligibilityRows: [],
    }),
    now: () => now,
    ...overrides,
  };
}

test("dashboard batch API requires authentication before loading", async () => {
  let loaded = false;
  const response = await handleDashboardShowsRequest(
    new NextRequest("https://example.test/api/dashboard/shows?cursor=abc"),
    dependencies({
      authenticate: async () => "unauthorized",
      loadBatch: async () => {
        loaded = true;
        return emptyBatch;
      },
    })
  );
  assert.equal(response.status, 401);
  assert.equal(loaded, false);
});

test("dashboard batch API rejects unknown, duplicate, and invalid inputs", async () => {
  for (const url of [
    "https://example.test/api/dashboard/shows?cursor=abc&where=all",
    "https://example.test/api/dashboard/shows?cursor=abc&cursor=def",
    "https://example.test/api/dashboard/shows?cursor=abc&mode=admin",
    "https://example.test/api/dashboard/shows?cursor=abc&search=%20trim%20",
  ]) {
    const response = await handleDashboardShowsRequest(
      new NextRequest(url),
      dependencies()
    );
    assert.equal(response.status, 400);
  }
  assert.equal(
    parseDashboardBatchRequest(
      new URL(
        "https://example.test/api/dashboard/shows?cursor=abc&mode=dismissed&range=30d&src=spotify&contact=needs&status=clicked&search=Four+Tet"
      )
    )?.query.mode,
    "dismissed"
  );
});

test("dashboard batch API validates cursor and returns read-safe data", async () => {
  const invalid = await handleDashboardShowsRequest(
    new NextRequest("https://example.test/api/dashboard/shows?cursor=abc"),
    dependencies({ loadBatch: async () => null })
  );
  assert.equal(invalid.status, 400);

  const response = await handleDashboardShowsRequest(
    new NextRequest("https://example.test/api/dashboard/shows?cursor=abc"),
    dependencies()
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    shows: [],
    nextCursor: null,
    sendabilityRows: [],
    followUpEligibilityRows: [],
  });
});
