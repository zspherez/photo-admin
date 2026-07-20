import assert from "node:assert/strict";
import test from "node:test";
import {
  festivalLeadTimeCutoff,
  festivalLeadTimeExclusion,
  festivalNycStatus,
  festivalLeadTimeWhere,
  satisfiesFestivalLeadTime,
} from "./festivalEligibility";

function festival(
  date: string,
  venueNycStatus: string | null
) {
  return {
    isFestival: true,
    date: new Date(`${date}T00:00:00.000Z`),
    city: "Chicago",
    state: "IL",
    countryCode: "US",
    venueNycStatus,
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

test("NYC is derived from cached venue geography or manual festival fields", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  assert.equal(
    satisfiesFestivalLeadTime(
      {
        ...festival("2026-07-20", null),
        edmtrainVenue: { nycStatus: "inside_nyc" },
      },
      now
    ),
    true
  );
  const manualNycFestival = {
    isFestival: true,
    date: new Date("2026-07-20T00:00:00.000Z"),
    city: "Brooklyn",
    state: "NY",
    countryCode: "US",
  };
  assert.equal(festivalNycStatus(manualNycFestival), "inside_nyc");
  assert.equal(satisfiesFestivalLeadTime(manualNycFestival, now), true);
});

test("unknown near-term geography fails conservatively and explicitly", () => {
  assert.equal(
    festivalLeadTimeExclusion(
      {
        isFestival: true,
        date: new Date("2026-07-26T00:00:00.000Z"),
        city: "Mystery City",
        state: null,
        countryCode: null,
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
  assert.deepEqual(where.OR?.slice(0, 3), [
    { isFestival: false },
    { date: { gte: new Date("2026-07-27T00:00:00.000Z") } },
    { edmtrainVenue: { is: { nycStatus: "inside_nyc" } } },
  ]);
  assert.deepEqual(where.OR?.[3], {
    AND: [
      { edmtrainVenueId: null },
      { countryCode: { equals: "US", mode: "insensitive" } },
      { state: { in: ["NY", "New York"], mode: "insensitive" } },
      {
        city: {
          in: [
            "astoria",
            "bronx",
            "brooklyn",
            "flushing",
            "long island city",
            "manhattan",
            "new york",
            "new york city",
            "queens",
            "staten island",
            "the bronx",
          ],
          mode: "insensitive",
        },
      },
    ],
  });
  assert.equal(
    satisfiesFestivalLeadTime(
      {
        isFestival: false,
        date: new Date("2026-07-20T00:00:00.000Z"),
      },
      new Date("2026-07-20T12:00:00.000Z")
    ),
    true
  );
});
