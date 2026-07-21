import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardHref,
  DEFAULT_FILTERS,
  getDashboardDateRange,
  getPagination,
  isDashboardArtistMatch,
  parseDashboardQuery,
} from "./match";
import { dashboardHrefWithoutLegacyPage } from "./dashboardQuery";

test("dashboard filters parse shareable URL state and reject invalid values", () => {
  assert.deepEqual(
    parseDashboardQuery({
      mode: ["unknown", "matched"],
      range: "30-60d",
      src: "spotify",
      contact: "needs",
      status: "clicked",
      search: "  Four Tet  ",
      page: "3",
    }),
    {
      mode: "unknown",
      filters: {
        range: "30-60d",
        source: "any",
        contact: "needs",
        status: "clicked",
        search: "Four Tet",
      },
    }
  );
  assert.deepEqual(
    parseDashboardQuery({
      mode: "invalid",
      range: "all",
      src: "apple",
      contact: "maybe",
      status: "queued",
      page: "-2",
    }),
    { mode: "matched", filters: DEFAULT_FILTERS }
  );
  assert.deepEqual(
    parseDashboardQuery({
      mode: "unknown",
      src: "spotify",
      search: "Bicep",
    }),
    {
      mode: "unknown",
      filters: { ...DEFAULT_FILTERS, search: "Bicep" },
    }
  );
});

test("dashboard URL generation omits defaults and obsolete page state", () => {
  assert.equal(
    buildDashboardHref({
      mode: "dismissed",
      filters: {
        ...DEFAULT_FILTERS,
        source: "statsfm",
        search: "Jamie xx",
      },
    }),
    "/dashboard?mode=dismissed&src=statsfm&search=Jamie+xx"
  );
  assert.equal(
    buildDashboardHref({ mode: "matched", filters: DEFAULT_FILTERS }),
    "/dashboard"
  );
  assert.equal(
    buildDashboardHref({
      mode: "unknown",
      filters: { ...DEFAULT_FILTERS, source: "spotify" },
    }),
    "/dashboard?mode=unknown"
  );
  assert.equal(
    dashboardHrefWithoutLegacyPage({
      mode: "dismissed",
      search: "Jamie xx",
      page: "4",
      marked: "1",
    }),
    "/dashboard?mode=dismissed&search=Jamie+xx&marked=1"
  );
  assert.equal(dashboardHrefWithoutLegacyPage({ mode: "matched" }), null);
});

test("dashboard date ranges use Eastern calendar dates", () => {
  const range = getDashboardDateRange(
    "30-60d",
    new Date("2026-07-17T03:59:59.000Z")
  );
  assert.equal(range.start.toISOString(), "2026-08-15T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-09-14T00:00:00.000Z");
});

test("pagination reports stable bounds and clamps stale page links", () => {
  assert.deepEqual(getPagination(50, 3), {
    requestedPage: 3,
    page: 3,
    pageSize: 24,
    pageCount: 3,
    total: 50,
    start: 49,
    end: 50,
    hasPrevious: true,
    hasNext: false,
  });
  assert.equal(getPagination(50, 9).page, 3);
  assert.equal(getPagination(0, 1).pageCount, 1);
});

test("expired-only artists become unknown rather than matched", () => {
  const artist = {
    popularity: 75,
    listenSignals: [
      {
        source: "spotify_recent",
        rank: null,
        expiresAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ],
  };
  const now = new Date("2026-07-16T00:00:00.000Z");
  assert.equal(isDashboardArtistMatch(artist, "matched", now), false);
  assert.equal(isDashboardArtistMatch(artist, "unknown", now), true);
});

test("show-state modes include matched and unknown artist eligibility", () => {
  const now = new Date("2026-07-16T00:00:00.000Z");
  const unknown = { popularity: 75, listenSignals: [] };
  const spotifyMatched = {
    popularity: 20,
    listenSignals: [
      {
        source: "spotify_recent",
        rank: null,
        expiresAt: new Date("2026-07-17T00:00:00.000Z"),
      },
    ],
  };
  const statsfmOnly = {
    popularity: 80,
    listenSignals: [
      {
        source: "statsfm_top",
        rank: 5,
        expiresAt: null,
      },
    ],
  };

  for (const mode of ["interested", "dismissed"] as const) {
    assert.equal(isDashboardArtistMatch(unknown, mode, now), true);
    assert.equal(
      isDashboardArtistMatch(
        spotifyMatched,
        mode,
        now,
        60,
        "spotify"
      ),
      true
    );
    assert.equal(
      isDashboardArtistMatch(statsfmOnly, mode, now, 60, "spotify"),
      false
    );
  }
});
