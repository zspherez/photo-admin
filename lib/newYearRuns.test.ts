import assert from "node:assert/strict";
import test from "node:test";
import { groupNewYearRuns, isNewYearRunDate, newYearRunWindow, newYearRunWindowsWithin } from "./newYearRuns";

test("New Year's window crosses years and advances after January 3 ET", () => {
  assert.deepEqual(
    newYearRunWindow(new Date("2027-01-04T04:30:00Z")),
    {
      year: 2026,
      start: new Date("2026-12-27T00:00:00Z"),
      end: new Date("2027-01-03T00:00:00Z"),
    }
  );
  assert.equal(newYearRunWindow(new Date("2027-01-04T06:00:00Z")).year, 2027);
  for (const date of ["2026-12-27", "2026-12-31", "2027-01-01", "2027-01-03"]) {
    assert.equal(isNewYearRunDate(date), true);
  }
  assert.equal(isNewYearRunDate("2026-12-26"), false);
  assert.equal(isNewYearRunDate("2027-01-04"), false);
  assert.deepEqual(
    newYearRunWindowsWithin({
      start: new Date("2026-12-30T00:00:00Z"),
      end: new Date("2027-01-02T00:00:00Z"),
    }),
    [{
      gte: new Date("2026-12-30T00:00:00Z"),
      lte: new Date("2027-01-02T00:00:00Z"),
    }]
  );
});

test("run requires two distinct known cities for the same non-rejected artist", () => {
  const show = (id: string, city: string, state: string, artistId = "artist-1", rejectedAt: Date | null = null) => ({
    id, city, state, date: new Date("2026-12-31T00:00:00Z"),
    artists: [{ artistId, rejectedAt, artist: { name: artistId } }],
  });
  const runs = groupNewYearRuns([
    show("a", "New York", "NY"),
    show("b", "new york", "NY"),
    show("c", "Chicago", "IL"),
    show("d", "Unknown", "CA"),
    show("e", "Miami", "FL", "artist-2"),
    show("f", "Orlando", "FL", "artist-2", new Date()),
  ]);
  assert.deepEqual(runs.map((run) => run.artistId), ["artist-1"]);
  assert.deepEqual(runs[0].shows.map((row) => row.id), ["a", "b", "c"]);
});
