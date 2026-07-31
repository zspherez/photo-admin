import assert from "node:assert/strict";
import test from "node:test";
import {
  FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH,
  normalizeFestivalUtmCampaign,
} from "./festivalUtm";

test("festival UTM campaigns trim, clear, and preserve valid text", () => {
  assert.equal(normalizeFestivalUtmCampaign("  experts-only-2026  "), "experts-only-2026");
  assert.equal(normalizeFestivalUtmCampaign("   "), null);
});

test("festival UTM campaigns reject oversized and control-character values", () => {
  assert.throws(
    () =>
      normalizeFestivalUtmCampaign(
        "x".repeat(FESTIVAL_UTM_CAMPAIGN_MAX_LENGTH + 1),
      ),
    /200 characters or fewer/,
  );
  assert.throws(
    () => normalizeFestivalUtmCampaign("festival\u0000campaign"),
    /invalid characters/,
  );
});
