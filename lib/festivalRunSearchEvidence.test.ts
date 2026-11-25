import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFestivalRunEvidence,
  festivalSuggestionsForConfirmedShows,
  validateFestivalRunEvidence,
} from "./festivalRunSearchEvidence";

const range = {
  start: new Date("2026-11-25T00:00:00Z"),
  end: new Date("2027-11-25T00:00:00Z"),
};

test("festival evidence accepts distinct Canadian and US festivals months apart", () => {
  const crssd = extractFestivalRunEvidence(
    "Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · San Diego, CA",
    "https://www.edmtrain.com/crssd", range,
  );
  const fvded = extractFestivalRunEvidence(
    "Arlo", "FVDED in the Park lineup Arlo", "July 9, 2027 · Vancouver, BC, Canada",
    "https://www.edmtrain.com/fvded", range,
  );
  assert.equal(crssd?.countryCode, "US");
  assert.equal(fvded?.countryCode, "CA");
  assert.equal(crssd && validateFestivalRunEvidence("Arlo", crssd, range), true);
  assert.equal(fvded && validateFestivalRunEvidence("Arlo", fvded, range), true);
  assert.deepEqual(festivalSuggestionsForConfirmedShows([crssd!, fvded!], []).length, 2);
  assert.deepEqual(festivalSuggestionsForConfirmedShows([crssd!], []).length, 0);
});

test("festival evidence accepts explicit European and Latin American countries", () => {
  for (const [location, code] of [
    ["Paris, France", "FR"],
    ["London, United Kingdom", "GB"],
    ["Mexico City, Mexico", "MX"],
    ["Bogotá, Colombia", "CO"],
    ["São Paulo, Brazil", "BR"],
  ]) {
    const row = extractFestivalRunEvidence(
      "Arlo", "Arlo at Horizon Festival", `March 14, 2027 · ${location}`,
      "https://www.edmtrain.com/lineup", range,
    );
    assert.equal(row?.countryCode, code, location);
    assert.equal(row?.region, "");
    assert.equal(row && validateFestivalRunEvidence("Arlo", row, range), true);
  }
});

test("festival suggestions stay review-only and omit a matching confirmed show", () => {
  const row = extractFestivalRunEvidence(
    "Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · San Diego, CA",
    "https://www.edmtrain.com/crssd", range,
  )!;
  const confirmed = [
    { date: new Date("2027-03-14T00:00:00Z"), eventName: "CRSSD Festival", venueName: "Waterfront" },
    { date: new Date("2027-07-09T00:00:00Z"), eventName: "FVDED in the Park", venueName: "Park" },
  ];
  assert.deepEqual(festivalSuggestionsForConfirmedShows([row], confirmed), []);
});

test("festival evidence rejects missing dates, false artist matches, invalid locations and out-of-range dates", () => {
  for (const [artist, title, block] of [
    ["Arlo", "CRSSD Festival", "March 14, 2027 · San Diego, CA"],
    ["Arlo", "Carlot at CRSSD Festival", "March 14, 2027 · San Diego, CA"],
    ["Arlo", "Arlo at CRSSD Festival", "March 2027 · San Diego, CA"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · online, CA"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · San Diego, CA · Miami, FL"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2028 · San Diego, CA"],
    ["Arlo", "Arlo at CRSSD Festival", "Feb 30, 2027 · San Diego, CA"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · Paris, France · London, United Kingdom"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · Sydney, Australia"],
    ["Arlo", "Arlo at CRSSD Festival", "March 14, 2027 · Paris, not a country"],
  ]) {
    assert.equal(extractFestivalRunEvidence(
      artist, title, block, "https://www.edmtrain.com/event", range,
    ), null, `${title}: ${block}`);
  }
});
