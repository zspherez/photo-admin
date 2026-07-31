import assert from "node:assert/strict";
import test from "node:test";
import { outreachClickLabel } from "./outreachClickStream";

test("festival clicks prefer campaign and content", () => {
  assert.equal(
    outreachClickLabel({
      artistName: "Canonical Artist",
      artistCustomName: "Display Artist",
      isFestival: true,
      utmCampaign: "experts-only",
      utmContent: "yetti",
    }),
    "experts-only · yetti",
  );
});

test("ordinary and untracked clicks use the artist display name", () => {
  assert.equal(
    outreachClickLabel({
      artistName: "Canonical Artist",
      artistCustomName: "Display Artist",
      isFestival: false,
      utmCampaign: "outreach",
      utmContent: "display-artist",
    }),
    "Display Artist",
  );
});
