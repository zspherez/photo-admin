import assert from "node:assert/strict";
import test from "node:test";
import { selectNewYearSearchArtistIds, type RankedArtistSignal } from "./newYearSearchRanking";

const now = new Date("2026-11-01T12:00:00Z");
const signal = (
  artistId: string,
  source: string,
  rank: number | null,
  expiresAt: Date | null = null
): RankedArtistSignal => ({ artistId, source, rank, expiresAt });

test("best active rank wins per artist; equal ranks use a stable artist ID tie-break", () => {
  const signals = [
    signal("z", "spotify_top_long", 9),
    signal("z", "spotify_top_short", 1),
    signal("a", "spotify_top_medium", 1),
    signal("late", "spotify_top_short", 2, new Date("2026-11-01T11:59:59Z")),
    signal("rank-101", "spotify_top_long", 101),
    signal("unranked", "spotify_top_long", null),
    signal("recent", "spotify_recent", 1),
    signal("stats", "statsfm_weeks", 100),
    signal("stats", "statsfm_lifetime", 1),
    signal("a", "statsfm_months", 2),
  ];
  assert.deepEqual(selectNewYearSearchArtistIds(signals, now), ["a", "z", "stats"]);
  assert.deepEqual(selectNewYearSearchArtistIds(signals.toReversed(), now), ["a", "z", "stats"]);
});

test("three top ranges per service still yield at most 100 unique artists each and 200 total", () => {
  const signals: RankedArtistSignal[] = [];
  for (let rank = 1; rank <= 100; rank++) {
    const pad = String(rank).padStart(3, "0");
    signals.push(signal(`s-a-${pad}`, "spotify_top_long", rank));
    signals.push(signal(`s-b-${pad}`, "spotify_top_medium", rank));
    signals.push(signal(`s-c-${pad}`, "spotify_top_short", rank));
    signals.push(signal(rank <= 20 ? `s-a-${pad}` : `f-a-${pad}`, "statsfm_lifetime", rank));
    signals.push(signal(`f-b-${pad}`, "statsfm_months", rank));
    signals.push(signal(`f-c-${pad}`, "statsfm_weeks", rank));
  }
  const selected = selectNewYearSearchArtistIds(signals, now);
  assert.equal(selected.length, 180);
  assert.equal(new Set(selected).size, 180);
  assert.equal(selected.slice(0, 100).filter((id) => id.startsWith("s-")).length, 100);
  assert.ok(selected.includes("s-a-001"));
  assert.ok(selected.includes("s-c-033"));
  assert.ok(!selected.includes("s-a-100"));
  assert.deepEqual(selectNewYearSearchArtistIds(signals.toReversed(), now), selected);
});
