import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyEdmtrainVenueGeography,
  resolveEdmtrainVenue,
  type EdmtrainVenueInput,
} from "./edmtrainVenue";

function venue(overrides: Partial<EdmtrainVenueInput> = {}): EdmtrainVenueInput {
  return {
    id: 42,
    name: "Test Venue",
    address: "123 Example St, Brooklyn, NY 11201",
    location: "Brooklyn, NY",
    state: "NY",
    country: "United States",
    latitude: 40.6928,
    longitude: -73.9903,
    ...overrides,
  };
}

test("EDMTrain provider locality identifies an NYC venue", () => {
  assert.deepEqual(classifyEdmtrainVenueGeography(venue()), {
    status: "inside_nyc",
    reason: "provider_nyc_locality",
  });
});

test("Surf Lodge in Montauk is outside NYC by provider geography", () => {
  assert.deepEqual(
    classifyEdmtrainVenueGeography(
      venue({
        name: "The Surf Lodge",
        address: "183 Edgemere St, Montauk, NY 11954",
        location: "Montauk, NY",
        latitude: 41.0359,
        longitude: -71.9545,
      })
    ),
    {
      status: "outside_nyc",
      reason: "provider_non_nyc_locality",
    }
  );
});

test("incomplete provider geography remains unknown instead of assuming NYC", () => {
  assert.deepEqual(
    classifyEdmtrainVenueGeography(
      venue({
        address: "",
        location: "",
        state: "",
        country: "",
        latitude: 0,
        longitude: 0,
      })
    ),
    {
      status: "unknown",
      reason: "insufficient_provider_geography",
    }
  );
});

test("unchanged provider geography reuses the cached classification", () => {
  const first = resolveEdmtrainVenue(venue());
  const second = resolveEdmtrainVenue(venue(), {
    id: first.id,
    address: first.address,
    location: first.location,
    city: first.city,
    state: first.state,
    countryCode: first.countryCode,
    countryName: first.countryName,
    latitude: first.latitude,
    longitude: first.longitude,
    nycStatus: first.nycStatus,
    nycStatusReason: first.nycStatusReason,
    classificationVersion: first.classificationVersion,
    sourceFingerprint: first.sourceFingerprint,
  });
  assert.equal(second.reused, true);
  assert.equal(second.nycStatus, "inside_nyc");
});

test("venue cache migration backfills existing shows and fails unknown regular shows closed", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260720060000_edmtrain_venue_cache/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TABLE "EdmtrainVenue"/);
  assert.match(migration, /UPDATE "Show" AS "show"[\s\S]*"edmtrainVenueId"/);
  assert.match(
    migration,
    /"isFestival" = false[\s\S]*"syncStatus" = 'active'/
  );
  assert.match(
    migration,
    /SET "syncStatus" = 'geography_unknown'[\s\S]*"edmtrainVenueId" IS NULL/
  );
  assert.match(migration, /COMMIT;\s*$/);
});
