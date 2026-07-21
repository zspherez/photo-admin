import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAgentSafeSourceUrl,
  assertNoPhoneLikeNumber,
  containsPhoneLikeNumber,
  normalizeUnicodeDigits,
} from "./phoneSafety";

test("phone safety normalizes Unicode digits and rejects international formats", () => {
  assert.equal(normalizeUnicodeDigits("＋١٢３"), "+123");
  for (const value of [
    "+1 (212) 555-0199",
    "212/555/0199",
    "020 7123 4567",
    "＋٤٤／٢٠／٧١٢٣／٤٥٦٧",
    "１２３.４５６.７８９０",
    "Call (030) 1234-5678",
    "Local line 5550199",
  ]) {
    assert.equal(containsPhoneLikeNumber(value), true, value);
    assert.throws(
      () => assertNoPhoneLikeNumber(value, "field"),
      /cannot contain a phone number/,
    );
  }
});

test("phone safety permits dates, short versions, and ordinary prose", () => {
  for (const value of [
    "Evidence published 2026-07-21.",
    "Rule version 123456.",
    "Use the number already on file.",
    "Artist ID 1234567890",
  ]) {
    assert.equal(containsPhoneLikeNumber(value), false, value);
  }
});

test("agent source URLs reject phone paths and queries but permit durable IDs", () => {
  for (const value of [
    "https://example.com/contact/%2B1-212-555-0199",
    "https://example.com/team?phone=2125550199",
    "https://example.com/team?q=%2B44%2020%207123%204567",
  ]) {
    assert.throws(
      () => assertAgentSafeSourceUrl(value, "source URL"),
      /cannot contain a phone number/,
    );
  }
  assert.doesNotThrow(() =>
    assertAgentSafeSourceUrl(
      "https://example.com/artists/1234567890?release=2026-07-21&id=1234567890",
      "source URL",
    ),
  );
});
