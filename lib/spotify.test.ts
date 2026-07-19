import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SpotifyApiError,
  SpotifyPlaylistDetailsMutationUncertainError,
  SpotifyPlaylistMutationUncertainError,
  buildSpotifyPlaylistReconciliationPlan,
  classifySpotifyPlaylistItemsError,
  finalizeSpotifySyncResult,
  getCurrentSpotifyUserId,
  isSpotifyPlaylistOwnedByUser,
  playlistOwnedByUser,
  replacePlaylistItems,
  searchTrackUri,
  spotifyPlaylistSignalArtistIds,
  syncSpotifyListens,
  updatePlaylistDescription,
} from "./spotify";
import {
  createOperationDeadline,
  DeferredRetryError,
  OperationDeadlineExceededError,
} from "./integrationUtils";

test("Spotify playlist ownership is tied to the authenticated user id", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url
    );
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v1/me") {
      return Response.json({ id: "current-user" });
    }
    if (url.pathname.endsWith("/owned")) {
      return Response.json({
        id: "owned",
        owner: { id: "current-user" },
      });
    }
    return Response.json({
      id: "foreign",
      collaborative: true,
      owner: { id: "other-user" },
    });
  }) as typeof fetch;

  try {
    const deadline = createOperationDeadline(30_000, { now: () => 0 });
    const userId = await getCurrentSpotifyUserId("token", deadline);
    assert.equal(userId, "current-user");
    assert.equal(
      await playlistOwnedByUser("owned", userId, "token", deadline),
      true
    );
    assert.equal(
      await playlistOwnedByUser("foreign", userId, "token", deadline),
      false
    );
    assert.deepEqual(requests, [
      "/v1/me",
      "/v1/playlists/owned?fields=id,owner(id)",
      "/v1/playlists/foreign?fields=id,owner(id)",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("foreign collaborative and followed Spotify playlists are not owned", () => {
  assert.equal(
    isSpotifyPlaylistOwnedByUser(
      { owner: { id: "other-user" } },
      "current-user"
    ),
    false
  );
  assert.equal(
    isSpotifyPlaylistOwnedByUser(
      { owner: { id: "current-user" } },
      "current-user"
    ),
    true
  );
  assert.equal(
    isSpotifyPlaylistOwnedByUser({ owner: undefined }, "current-user"),
    false
  );
});

test("playlist item authorization failures are incomplete snapshots", () => {
  assert.equal(
    classifySpotifyPlaylistItemsError(
      new SpotifyApiError(403, "private playlist", null)
    ),
    "forbidden"
  );
  assert.equal(
    classifySpotifyPlaylistItemsError(
      new SpotifyApiError(404, "not found", null)
    ),
    "not-found"
  );
  assert.equal(
    classifySpotifyPlaylistItemsError(
      new SpotifyApiError(429, "rate limited", 1_000)
    ),
    null
  );
  assert.equal(
    classifySpotifyPlaylistItemsError(
      new SpotifyApiError(503, "unavailable", null)
    ),
    null
  );
});

test("incomplete playlists preserve links and discard partial observations", () => {
  const plan = buildSpotifyPlaylistReconciliationPlan([
    {
      playlistId: "complete",
      state: "complete",
      artistIds: ["observed"],
    },
    {
      playlistId: "private",
      state: "forbidden",
      artistIds: ["partial-must-not-be-used"],
    },
    {
      playlistId: "gone",
      state: "not-found",
      artistIds: ["missing-must-not-be-used"],
    },
  ]);

  assert.deepEqual(plan, {
    presentPlaylistIds: ["complete", "private"],
    replacePlaylistIds: ["complete"],
    preservePlaylistIds: ["private"],
    observedArtistIds: ["observed"],
    complete: false,
  });
});

test("partial playlist signals use updated accessible links plus preserved inaccessible links", () => {
  const allPlaylistArtistIds = spotifyPlaylistSignalArtistIds([
    "accessible-added",
    "private-preserved",
    "accessible-added",
  ]);

  assert.deepEqual(allPlaylistArtistIds, [
    "accessible-added",
    "private-preserved",
  ]);
  assert.equal(allPlaylistArtistIds.includes("accessible-removed"), false);
});

test("incomplete playlist reconciliation is an actionable non-success", () => {
  const result = finalizeSpotifySyncResult({
    topLong: 1,
    topMedium: 1,
    topShort: 1,
    recent: 1,
    followed: 1,
    playlists: {
      playlists: 2,
      artists: 4,
      removed: 0,
      incomplete: 1,
      complete: false,
      issues: [
        {
          playlistId: "private",
          name: "Private set",
          state: "forbidden",
        },
      ],
    },
    identityConflicts: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  if (!result.ok) {
    assert.equal(result.details.stalePlaylistDataPreserved, true);
    assert.equal(result.details.playlists[0]?.playlistId, "private");
    assert.match(result.details.action, /Verify/);
  }
});

test("Spotify pagination shares one absolute fake-clock deadline", async () => {
  const originalFetch = globalThis.fetch;
  let nowMs = 0;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    nowMs += 4_000;
    return Response.json({
      tracks: {
        items: [],
        next: `https://api.spotify.com/v1/search?page=${fetches + 1}`,
      },
    });
  }) as typeof fetch;

  try {
    const deadline = createOperationDeadline(12_000, {
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs;
      },
    });
    await assert.rejects(
      searchTrackUri("Track", "Artist", "token", deadline),
      OperationDeadlineExceededError
    );
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify preserves Retry-After instead of squeezing it into the deadline", async () => {
  const originalFetch = globalThis.fetch;
  const sleeps: number[] = [];
  globalThis.fetch = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "6" },
    })) as typeof fetch;

  try {
    const deadline = createOperationDeadline(10_000, {
      now: () => 0,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });
    await assert.rejects(
      searchTrackUri("Track", "Artist", "token", deadline),
      (error) => {
        assert.ok(error instanceof DeferredRetryError);
        assert.equal(error.retryAfterMs, 6_000);
        assert.equal(error.safeExecutionBudgetMs, 5_000);
        return true;
      }
    );
    assert.deepEqual(sleeps, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatched Spotify playlist timeouts have an explicitly uncertain outcome", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw Object.assign(new Error("connection lost after dispatch"), {
      name: "AbortError",
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      replacePlaylistItems(
        "playlist",
        ["spotify:track:one"],
        "token",
        createOperationDeadline(10_000, { now: () => 0 })
      ),
      (error) => {
        assert.ok(error instanceof SpotifyPlaylistMutationUncertainError);
        assert.equal(error.playlistId, "playlist");
        assert.equal(error.desiredTrackCount, 1);
        return true;
      }
    );
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pre-dispatch Spotify playlist deadline failures remain safe deferrals", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      replacePlaylistItems(
        "playlist",
        ["spotify:track:one"],
        "token",
        createOperationDeadline(4_999, { now: () => 0 })
      ),
      (error) => {
        assert.ok(error instanceof OperationDeadlineExceededError);
        assert.equal(
          error instanceof SpotifyPlaylistMutationUncertainError,
          false
        );
        return true;
      }
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify playlist descriptions use the supported details endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    pathname: string;
    method: string;
    body: unknown;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url
    );
    requests.push({
      pathname: url.pathname,
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await updatePlaylistDescription(
      "playlist/id",
      "Last updated",
      "token",
      createOperationDeadline(10_000, { now: () => 0 })
    );
    assert.deepEqual(requests, [
      {
        pathname: "/v1/playlists/playlist%2Fid",
        method: "PUT",
        body: { description: "Last updated" },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ambiguous playlist description updates are not broadly retried", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw Object.assign(new Error("connection lost after dispatch"), {
      name: "AbortError",
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      updatePlaylistDescription(
        "playlist",
        "description",
        "token",
        createOperationDeadline(10_000, { now: () => 0 })
      ),
      (error) => {
        assert.ok(
          error instanceof SpotifyPlaylistDetailsMutationUncertainError
        );
        assert.equal(error.playlistId, "playlist");
        return true;
      }
    );
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Spotify reconciliation uses deadline-bound database transaction options", () => {
  const source = readFileSync(new URL("./spotify.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /runDeadlineBoundTransaction\(\s*deadline,\s*SPOTIFY_RECONCILIATION_TRANSACTION/
  );
  assert.match(source, /minimumTimeoutMs: 30_000/);
  assert.match(source, /minimumDeadlineTransactionRemainingMs\(/);
  assert.doesNotMatch(
    source,
    /\{\s*maxWait:\s*10_000,\s*timeout:\s*120_000\s*\}/
  );
});

test("Spotify defers before lease or snapshot work when transaction budget is unsafe", async () => {
  const result = await syncSpotifyListens(
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
