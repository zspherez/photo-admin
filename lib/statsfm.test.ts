import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOperationDeadline } from "./integrationUtils";
import {
  resolveStatsfmSpotifyIdentity,
  syncStatsfmTopArtistRanges,
  type StatsfmTopArtistItem,
} from "./statsfm";

function statsfmArtist(spotifyIds: string[]): StatsfmTopArtistItem {
  return {
    position: 1,
    streams: 1,
    playedMs: 1,
    artist: {
      id: 24118,
      name: "Taylor Swift",
      genres: [],
      image: null,
      spotifyPopularity: null,
      followers: null,
      externalIds: { spotify: spotifyIds },
    },
  };
}

test("Stats.fm requests and callers share operation deadlines", () => {
  const source = readFileSync(new URL("./statsfm.ts", import.meta.url), "utf8");
  const route = readFileSync(
    new URL("../app/api/cron/sync-listens/route.ts", import.meta.url),
    "utf8",
  );
  const playlist = readFileSync(
    new URL("./topPlaylist.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /operationDeadlineSignal\(deadline, operation\)/);
  assert.match(source, /waitForRetryBeforeDeadline\(/);
  assert.match(source, /"Stats\.fm reconciliation"/);
  assert.match(
    source,
    /runDeadlineBoundTransaction\(\s*deadline,\s*STATSFM_RECONCILIATION_TRANSACTION/,
  );
  assert.match(source, /minimumTimeoutMs: 30_000/);
  assert.doesNotMatch(
    source,
    /\{\s*maxWait:\s*10_000,\s*timeout:\s*120_000\s*\}/,
  );
  assert.match(
    route,
    /syncStatsfmTopArtistRanges\(metadata\.userId,[\s\S]*?\], deadline\)/,
  );
  assert.match(
    playlist,
    /getTopTracks\(userId, "weeks", limit, deadline\)/,
  );
});

test("Stats.fm defers before lease or provider reads without a safe transaction budget", async () => {
  const result = await syncStatsfmTopArtistRanges(
    "user",
    [{ range: "lifetime", limit: 500 }],
    createOperationDeadline(20_000, { now: () => 0 })
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "deferred");
  if (result.status === "deferred") {
    assert.equal(result.details.requiredMs, 31_001);
    assert.equal(result.details.destructiveWorkStarted, false);
    assert.equal(result.details.priorSnapshotPreserved, true);
  }
});

test("ambiguous Stats.fm Spotify ids remain safely unlinked", () => {
  assert.deepEqual(
    resolveStatsfmSpotifyIdentity(
      statsfmArtist([
        "0EnfKiZg4Bgj8TN6RZvKpR",
        "7nehoivkuzx1IsSPZTlm7w",
        "06HL4z0CvFAxyc27GXpf02",
      ])
    ),
    {
      spotifyId: null,
      ambiguousCandidateCount: 3,
      candidateIds: [
        "0EnfKiZg4Bgj8TN6RZvKpR",
        "7nehoivkuzx1IsSPZTlm7w",
        "06HL4z0CvFAxyc27GXpf02",
      ],
    }
  );
  assert.deepEqual(
    resolveStatsfmSpotifyIdentity(
      statsfmArtist(["06HL4z0CvFAxyc27GXpf02"])
    ),
    {
      spotifyId: "06HL4z0CvFAxyc27GXpf02",
      ambiguousCandidateCount: 0,
      candidateIds: ["06HL4z0CvFAxyc27GXpf02"],
    }
  );
});
