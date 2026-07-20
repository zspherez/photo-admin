import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("settings no longer read, write, or display the venue blocklist", () => {
  const generalSettings = source("lib/generalSettings.ts");
  const generalPage = source("app/settings/general/page.tsx");
  const settingsIndex = source("app/settings/page.tsx");

  for (const contents of [generalSettings, generalPage, settingsIndex]) {
    assert.doesNotMatch(contents, /venue_blocklist|venue blocklist/i);
  }
  assert.match(settingsIndex, /key: "portfolio_url"/);
  assert.match(settingsIndex, /\/1 set/);
});

test("EDMTrain sync has no venue-name filtering or blocklist result count", () => {
  const edmtrain = source("lib/edmtrain.ts");
  const showsPage = source("app/shows/page.tsx");

  assert.doesNotMatch(
    edmtrain,
    /DEFAULT_VENUE_BLOCKLIST|getVenueBlocklist|isBlocked|venue_blocklist|skippedVenue/,
  );
  assert.doesNotMatch(showsPage, /blocklisted|skippedVenue|sp\.skipped/);
  assert.match(
    edmtrain,
    /status: edmtrainEventStatus\(event, venue\.nycStatus, now\)/,
  );
});

test("removal migration deletes the obsolete setting and safely reconciles legacy EDMTrain rows", () => {
  const migration = source(
    "prisma/migrations/20260720210000_remove_venue_blocklist/migration.sql",
  );

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /SET LOCAL TIME ZONE 'America\/New_York'/);
  assert.match(
    migration,
    /DELETE FROM "Setting"[\s\S]*"key" = 'venue_blocklist'/,
  );
  assert.match(
    migration,
    /show\."source" = 'edmtrain'[\s\S]*show\."syncStatus" = 'blocked'/,
  );
  assert.match(
    migration,
    /legacy\."date" < CURRENT_DATE[\s\S]*THEN 'festival_past'/,
  );
  assert.match(
    migration,
    /legacy\."date" >= CURRENT_DATE \+ INTERVAL '7 days'[\s\S]*THEN 'active'/,
  );
  assert.match(
    migration,
    /legacy\."nycStatus" = 'outside_nyc'[\s\S]*THEN 'lead_time_outside_nyc'/,
  );
  assert.match(
    migration,
    /WHEN legacy\."nycStatus" = 'outside_nyc'[\s\S]*THEN 'outside_nyc'[\s\S]*ELSE 'geography_unknown'/,
  );
  assert.doesNotMatch(migration, /"dismissedAt"|DELETE FROM "Show"/);
  assert.match(migration, /COMMIT;\s*$/);
});
