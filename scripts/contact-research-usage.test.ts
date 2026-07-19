import assert from "node:assert/strict";
import test from "node:test";
import {
  creditsFromNanoAiu,
  parseUsageEvent,
  summarizeUsageRecords,
} from "./contact-research-usage.mjs";

test("converts nano-AIU checkpoints into AI credits", () => {
  assert.equal(creditsFromNanoAiu(12_500_000_000), 12.5);
  assert.equal(
    parseUsageEvent({
      type: "session.usage_checkpoint",
      data: { totalNanoAiu: 4_250_000_000 },
    }),
    4_250_000_000
  );
});

test("summarizes per-artist AI-credit records", () => {
  assert.deepEqual(
    summarizeUsageRecords([
      { artist: "A", nanoAiu: 10_000_000_000 },
      { artist: "B", nanoAiu: 20_000_000_000 },
      { artist: null, nanoAiu: 5_000_000_000 },
    ]),
    {
      artists: 2,
      totalNanoAiu: 30_000_000_000,
      totalCredits: 30,
      averageCredits: 15,
    }
  );
});
