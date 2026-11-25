import assert from "node:assert/strict";
import test from "node:test";
import { festivalRunDaysAhead, festivalRunWindow, groupFestivalRuns } from "./festivalRuns";

test("festival window rolls across years using the Eastern calendar date", () => {
  assert.deepEqual(festivalRunWindow(new Date("2026-11-25T02:00:00Z")), {
    start: new Date("2026-11-24T00:00:00Z"),
    end: new Date("2027-11-24T00:00:00Z"),
  });
  assert.deepEqual(festivalRunWindow(new Date("2026-11-25T15:00:00Z")), {
    start: new Date("2026-11-25T00:00:00Z"),
    end: new Date("2027-11-25T00:00:00Z"),
  });
  assert.equal(festivalRunDaysAhead(new Date("2026-11-25T15:00:00Z")), 364);
  assert.equal(festivalRunDaysAhead(new Date("2027-11-25T15:00:00Z")), 365);
});

test("a festival run requires two differently named festivals, not two dates at one festival", () => {
  const show = (
    id: string, eventName: string | null, artistId = "arlo", rejectedAt: Date | null = null,
  ) => ({
    id, eventName, venueName: "Festival Grounds",
    date: new Date(`2027-${id === "a" ? "03" : "07"}-15T00:00:00Z`),
    artists: [{ artistId, rejectedAt, artist: { name: artistId } }],
  });
  const runs = groupFestivalRuns([
    show("a", "CRSSD"),
    show("b", "crssd Festival "),
    show("c", "FVDED in the Park"),
    show("d", "Unknown"),
    show("e", "CRSSD", "other"),
    show("f", "FVDED in the Park", "other", new Date()),
  ]);
  assert.deepEqual(runs.map((run) => run.artistId), ["arlo"]);
  assert.deepEqual(runs[0].shows.map((row) => row.id), ["a", "b", "c"]);
});
