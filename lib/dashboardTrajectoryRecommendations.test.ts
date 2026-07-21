import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import type { MatchedShow } from "@/lib/match";
import { getDashboardRecommendationBadges } from "./dashboardTrajectoryRecommendations";

const now = new Date("2026-07-21T20:00:00.000Z");
const activeRun = {
  id: "run-1",
  generatedAt: new Date("2026-07-21T18:00:00.000Z"),
  validUntil: new Date("2026-07-22T18:00:00.000Z"),
  status: "ready" as const,
};

function shows(): MatchedShow[] {
  return [
    {
      id: "show-1",
      matchedArtists: [{ id: "artist-1" }, { id: "artist-2" }],
    },
    {
      id: "show-2",
      matchedArtists: [{ id: "artist-1" }],
    },
  ] as unknown as MatchedShow[];
}

test("dashboard model badges are optional when no fresh active run exists", async () => {
  for (const availability of ["none", "stale", "expired"] as const) {
    let queried = false;
    const result = await getDashboardRecommendationBadges(shows(), now, {
      resolveRun: async () => ({
        availability,
        run: availability === "none" ? null : activeRun,
      }),
      findRecommendations: async () => {
        queried = true;
        return [];
      },
    });

    assert.deepEqual(result, []);
    assert.equal(queried, false);
  }
});

test("dashboard remains compatible when optional model tables are unavailable", async () => {
  const result = await getDashboardRecommendationBadges(shows(), now, {
    resolveRun: async () => {
      throw new Prisma.PrismaClientKnownRequestError("missing table", {
        code: "P2021",
        clientVersion: "6.19.3",
      });
    },
    findRecommendations: async () => {
      throw new Error("must not query");
    },
  });
  assert.deepEqual(result, []);
});

test("dashboard badges use one exact batch lookup for already-visible matches", async () => {
  let queryCount = 0;
  const result = await getDashboardRecommendationBadges(shows(), now, {
    resolveRun: async () => ({ availability: "ready", run: activeRun }),
    findRecommendations: async (runId, showIds, artistIds) => {
      queryCount += 1;
      assert.equal(runId, activeRun.id);
      assert.deepEqual(showIds, ["show-1", "show-2"]);
      assert.deepEqual(artistIds, ["artist-1", "artist-2"]);
      return [
        {
          id: "portfolio",
          runId,
          showId: "show-1",
          arm: "portfolio",
          isSuggested: false,
          listRank: 1,
          slatePosition: null,
          runArtist: { artistId: "artist-1" },
        },
        {
          id: "trajectory",
          runId,
          showId: "show-1",
          arm: "trajectory",
          isSuggested: true,
          listRank: 8,
          slatePosition: 2,
          runArtist: { artistId: "artist-1" },
        },
        {
          id: "same-night",
          runId,
          showId: "show-2",
          arm: "exploration",
          isSuggested: false,
          listRank: 3,
          slatePosition: null,
          runArtist: { artistId: "artist-1" },
        },
        {
          id: "not-visible",
          runId,
          showId: "show-other",
          arm: "trajectory",
          isSuggested: true,
          listRank: 1,
          slatePosition: 1,
          runArtist: { artistId: "artist-1" },
        },
      ];
    },
  });

  assert.equal(queryCount, 1);
  assert.deepEqual(
    result.map((badge) => [
      badge.recommendationId,
      badge.showId,
      badge.artistId,
    ]),
    [
      ["trajectory", "show-1", "artist-1"],
      ["same-night", "show-2", "artist-1"],
    ],
  );
});
