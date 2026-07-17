import assert from "node:assert/strict";
import test from "node:test";
import {
  countryLabel,
  normalizeCountry,
  normalizeCountryCode,
} from "./country";

test("country normalization recognizes US, Canada, and other countries", () => {
  assert.deepEqual(normalizeCountry("United States"), {
    countryCode: "US",
    countryName: "United States",
  });
  assert.deepEqual(normalizeCountry("Canada"), {
    countryCode: "CA",
    countryName: "Canada",
  });
  assert.deepEqual(normalizeCountry("Mexico"), {
    countryCode: "MX",
    countryName: "Mexico",
  });
  assert.equal(normalizeCountryCode("gb"), "GB");
  assert.equal(normalizeCountryCode("United Kingdom"), "GB");
});

test("unknown provider countries remain explicit instead of becoming US", () => {
  assert.deepEqual(normalizeCountry("Atlantis"), {
    countryCode: null,
    countryName: "Atlantis",
  });
  assert.deepEqual(normalizeCountry(""), {
    countryCode: null,
    countryName: null,
  });
  assert.equal(
    countryLabel({ countryCode: null, countryName: "Atlantis" }),
    "Atlantis (country code unknown)"
  );
  assert.equal(
    countryLabel({ countryCode: null, countryName: null }),
    "Unknown country"
  );
});
