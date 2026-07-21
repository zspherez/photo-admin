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
    "https://example.com/tel/2125550199",
    "https://example.com/phone/１２１２５５５０１９９",
    "https://example.com/mobile/02071234567",
    "https://example.com/call/2125550199",
    "https://example.com/sms/2125550199",
    "https://example.com/whatsapp/2125550199",
    "https://example.com/team?phone=2125550199",
    "https://example.com/team?phone=",
    "https://example.com/team?q=%2B44%2020%207123%204567",
    "https://example.com/team?q=telephone%202125550199",
    "https://2125550199.example.com/team",
    "https://１２１２５５５０１９９.example.com/team",
    "https://phone-212-555-0199.example.com/team",
    "https://example.com/artists/2125550199",
  ]) {
    assert.throws(
      () => assertAgentSafeSourceUrl(value, "source URL"),
      /cannot contain a phone number/,
    );
  }
  assert.doesNotThrow(() =>
    assertAgentSafeSourceUrl(
      "https://edmtrain.com/artists/1234567890?eventId=1234567890",
      "source URL",
    ),
  );
  assert.doesNotThrow(() =>
    assertAgentSafeSourceUrl(
      "https://instagram.com/1234567890/?id=1234567890",
      "source URL",
    ),
  );
  assert.doesNotThrow(() =>
    assertAgentSafeSourceUrl(
      "https://example.com/releases/2026-07-21?id=1234567890",
      "source URL",
    ),
  );
});
