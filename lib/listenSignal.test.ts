import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRankLabel,
  isListenSignalActive,
  pickTopListenSignal,
} from "./listenSignal";

const now = new Date("2026-07-16T12:00:00.000Z");

test("rank labels preserve existing presentation text", () => {
  assert.equal(formatRankLabel("statsfm_weeks", 4), "Stats.fm 4wk #4");
  assert.equal(formatRankLabel("spotify_recent", null), "Spotify recent");
  assert.equal(formatRankLabel("custom_source", 2), "custom_source #2");
});

test("recent-play signals require an unexpired freshness timestamp", () => {
  assert.equal(
    isListenSignalActive(
      {
        source: "spotify_recent",
        expiresAt: new Date("2026-07-16T12:00:00.000Z"),
      },
      now
    ),
    false
  );
  assert.equal(
    isListenSignalActive(
      {
        source: "spotify_recent",
        expiresAt: new Date("2026-07-16T12:00:01.000Z"),
      },
      now
    ),
    true
  );
  assert.equal(
    isListenSignalActive({ source: "spotify_recent", expiresAt: null }, now),
    false
  );
  assert.equal(
    isListenSignalActive({ source: "statsfm_lifetime", expiresAt: null }, now),
    true
  );
});

test("top rank ignores expired signals and resolves ties deterministically", () => {
  const top = pickTopListenSignal(
    [
      {
        source: "spotify_recent",
        rank: 1,
        expiresAt: new Date("2026-07-16T11:59:59.000Z"),
      },
      { source: "spotify_top_short", rank: 4, expiresAt: null },
      { source: "statsfm_weeks", rank: 4, expiresAt: null },
      { source: "statsfm_lifetime", rank: 4, expiresAt: null },
    ],
    now
  );
  assert.deepEqual(top, {
    source: "statsfm_lifetime",
    rank: 4,
    expiresAt: null,
  });
});
