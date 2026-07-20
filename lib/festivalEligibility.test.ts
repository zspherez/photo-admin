import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  festivalLeadTimeCutoff,
  festivalLeadTimeExclusion,
  festivalLeadTimeWhere,
  satisfiesFestivalLeadTime,
} from "./festivalEligibility";

function festival(
  date: string,
  festivalNycStatus: string | null
) {
  return {
    isFestival: true,
    date: new Date(`${date}T00:00:00.000Z`),
    city: "Chicago",
    state: "IL",
    countryCode: "US",
    festivalNycStatus,
  };
}

test("festival lead time allows NYC and excludes only non-NYC days zero through six", () => {
  const now = new Date("2026-07-20T16:00:00.000Z");

  assert.equal(
    satisfiesFestivalLeadTime(festival("2026-07-20", "inside_nyc"), now),
    true
  );
  assert.equal(
    festivalLeadTimeExclusion(
      festival("2026-07-26", "outside_nyc"),
      now
    ),
    "lead_time_outside_nyc"
  );
  assert.equal(
    satisfiesFestivalLeadTime(festival("2026-07-27", "outside_nyc"), now),
    true
  );
  assert.equal(
    satisfiesFestivalLeadTime(festival("2026-08-20", "outside_nyc"), now),
    true
  );
});

test("NYC is exempt from lead time but not from being in the past", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  assert.equal(
    festivalLeadTimeExclusion(festival("2026-07-19", "inside_nyc"), now),
    "festival_past"
  );
  assert.equal(
    satisfiesFestivalLeadTime(festival("2026-07-20", "inside_nyc"), now),
    true
  );
  assert.equal(
    satisfiesFestivalLeadTime(festival("2026-07-21", "inside_nyc"), now),
    true
  );
});

test("unknown near-term geography fails conservatively and explicitly", () => {
  assert.equal(
    festivalLeadTimeExclusion(
      {
        isFestival: true,
        date: new Date("2026-07-26T00:00:00.000Z"),
        festivalNycStatus: "unknown",
      },
      new Date("2026-07-20T12:00:00.000Z")
    ),
    "lead_time_geography_unknown"
  );
});

test("festival lead time follows Eastern calendar dates across DST boundaries", () => {
  assert.equal(
    festivalLeadTimeCutoff(
      new Date("2026-03-08T04:59:59.000Z")
    ).toISOString(),
    "2026-03-14T00:00:00.000Z"
  );
  assert.equal(
    festivalLeadTimeCutoff(
      new Date("2026-03-08T05:00:00.000Z")
    ).toISOString(),
    "2026-03-15T00:00:00.000Z"
  );
  assert.equal(
    festivalLeadTimeCutoff(
      new Date("2026-11-01T03:59:59.000Z")
    ).toISOString(),
    "2026-11-07T00:00:00.000Z"
  );
  assert.equal(
    festivalLeadTimeCutoff(
      new Date("2026-11-01T04:00:00.000Z")
    ).toISOString(),
    "2026-11-08T00:00:00.000Z"
  );
});

test("database eligibility preserves regular shows and the exact seven-day boundary", () => {
  const where = festivalLeadTimeWhere(
    new Date("2026-07-20T12:00:00.000Z")
  );
  assert.deepEqual(where.OR, [
    { isFestival: false },
    {
      isFestival: true,
      date: { gte: new Date("2026-07-20T00:00:00.000Z") },
      OR: [
        { festivalNycStatus: "inside_nyc" },
        { date: { gte: new Date("2026-07-27T00:00:00.000Z") } },
      ],
    },
  ]);
  assert.equal(
    satisfiesFestivalLeadTime(
      {
        isFestival: false,
        date: new Date("2026-07-20T00:00:00.000Z"),
        festivalNycStatus: null,
      },
      new Date("2026-07-20T12:00:00.000Z")
    ),
    true
  );
});

test("migration persists canonical geography without changing historical rows", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260720170000_festival_lead_time/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(
    migration,
    /SET "festivalNycStatus" = venue\."nycStatus"[\s\S]*"edmtrainVenueId"/
  );
  assert.match(
    migration,
    /regexp_replace\([\s\S]*lower\(trim\("city"\)\)[\s\S]*'\[\^a-z0-9\]\+'[\s\S]*'new york'/
  );
  assert.doesNotMatch(migration, /DELETE FROM "Show"|SET "syncStatus"/);
  assert.match(migration, /COMMIT;\s*$/);
});
