import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  festivalCountryCategory,
  festivalGroupKey,
  festivalListPath,
  isFestivalVisible,
  parseFestivalListView,
} from "./festivalView";

const activeView = {
  includeInternational: false,
  dismissed: false,
};

function festival(
  countryCode: string | null,
  dismissedAt: Date | null = null,
  countryName: string | null = null,
  id = "festival"
) {
  return {
    id,
    eventName: "Same Name Festival",
    venueName: "Central Park",
    city: "Springfield",
    countryCode,
    countryName,
    dismissedAt,
  };
}

test("festival list defaults to active US festivals only", () => {
  assert.equal(isFestivalVisible(festival("US"), activeView), true);
  assert.equal(isFestivalVisible(festival("CA"), activeView), false);
  assert.equal(isFestivalVisible(festival("MX"), activeView), false);
  assert.equal(isFestivalVisible(festival(null), activeView), false);

  const internationalView = {
    ...activeView,
    includeInternational: true,
  };
  assert.equal(isFestivalVisible(festival("CA"), internationalView), true);
  assert.equal(isFestivalVisible(festival("MX"), internationalView), true);
  assert.equal(isFestivalVisible(festival(null), internationalView), true);
  assert.equal(festivalCountryCategory({ countryCode: null }), "unknown");
});

test("dismissed festivals disappear by default and return after restoration", () => {
  const dismissedAt = new Date("2026-07-16T12:00:00.000Z");
  const dismissedFestival = festival("US", dismissedAt);
  assert.equal(isFestivalVisible(dismissedFestival, activeView), false);
  assert.equal(
    isFestivalVisible(dismissedFestival, {
      ...activeView,
      dismissed: true,
    }),
    true
  );

  const restoredFestival = { ...dismissedFestival, dismissedAt: null };
  assert.equal(isFestivalVisible(restoredFestival, activeView), true);
});

test("same-name festivals in different countries never share a group", () => {
  assert.notEqual(
    festivalGroupKey(festival("US")),
    festivalGroupKey(festival("CA"))
  );
  assert.notEqual(
    festivalGroupKey(festival(null, null, "Country A")),
    festivalGroupKey(festival(null, null, "Country B"))
  );
  assert.notEqual(
    festivalGroupKey(festival(null, null, null, "unknown-a")),
    festivalGroupKey(festival(null, null, null, "unknown-b"))
  );
});

test("festival list query state is explicit and shareable", () => {
  assert.deepEqual(
    parseFestivalListView({
      includeInternational: ["1", "0"],
      dismissed: "true",
    }),
    { includeInternational: true, dismissed: true }
  );
  assert.equal(
    festivalListPath({ includeInternational: true, dismissed: true }),
    "/festivals?includeInternational=1&dismissed=1"
  );
});

test("festival geography migration preserves historical country semantics", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716200000_festival_geography/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    migration,
    /"countryCode" = 'US',\s*"countryName" = 'United States'[\s\S]*"isFestival" = true[\s\S]*"source" = 'manual'/,
  );
  assert.match(
    migration,
    /WHERE "source" = 'edmtrain' AND "raw" IS NOT NULL/,
  );
  assert.match(
    migration,
    /WHEN upper\("providerCountry"\."value"\) IN \('US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'\) THEN 'US'/,
  );
});
