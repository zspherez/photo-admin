import assert from "node:assert/strict";
import test from "node:test";
import {
  bestVenueTierShow,
  classifyVenueTier,
} from "./venueTier";

test("classifies curated venue and festival tiers", () => {
  assert.equal(classifyVenueTier("Brooklyn Mirage"), 3);
  assert.equal(classifyVenueTier("TBA", "Time Warp NYC"), 3);
  assert.equal(classifyVenueTier("Elsewhere Hall"), 1);
  assert.equal(classifyVenueTier("Elsewhere - Zone One"), 2);
  assert.equal(classifyVenueTier("Unknown Venue"), 0);
});

test("selects the highest-caliber upcoming show, then the earliest", () => {
  const best = bestVenueTierShow([
    {
      date: new Date("2026-08-01T00:00:00.000Z"),
      venueName: "Nowadays",
      eventName: null,
    },
    {
      date: new Date("2026-09-01T00:00:00.000Z"),
      venueName: "Brooklyn Mirage",
      eventName: null,
    },
    {
      date: new Date("2026-08-15T00:00:00.000Z"),
      venueName: "Barclays Center",
      eventName: null,
    },
  ]);
  assert.equal(best?.tier, 3);
  assert.equal(best?.venueName, "Barclays Center");
});
