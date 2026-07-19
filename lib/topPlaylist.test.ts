import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SPOTIFY_SYNC_LEASE_KEY,
  SpotifyApiError,
  SpotifyPlaylistDetailsMutationUncertainError,
  SpotifyPlaylistMutationUncertainError,
} from "./spotify";
import {
  assertOperationTimeRemaining,
  createOperationDeadline,
  DeadlineTransactionTimeoutError,
  DeferredRetryError,
  IntegrationSyncLeaseLostError,
  makeIntegrationSyncLeaseKey,
  OperationDeadlineExceededError,
  remainingOperationTimeMs,
} from "./integrationUtils";
import {
  asTopPlaylistExternalWritePartialResult,
  asTopPlaylistLeaseStaleResult,
  classifyTopPlaylistCreationFailure,
  formatManagedPlaylistDescription,
  minimumTopPlaylistCreationRemainingMs,
  minimumTopPlaylistExternalWriteRemainingMs,
  minimumTopPlaylistFreshnessRemainingMs,
  PLAYLIST_DESCRIPTION_BASE,
  refreshTopTracksPlaylist,
  runTopPlaylistCreationWithReservedDownstream,
  runTopPlaylistExternalWriteAndFreshness,
  runTopPlaylistExternalWrites,
  selectOwnedManagedPlaylist,
  TopPlaylistCreatedIncompleteError,
  TopPlaylistCreationOutcomeUncertainError,
  TopPlaylistDescriptionUpdateFailedError,
  TopPlaylistDescriptionUpdateUncertainError,
  TopPlaylistExternalWriteUncertainError,
  type TopPlaylistResult,
} from "./topPlaylist";

async function captureCreationFailure(error: unknown): Promise<unknown> {
  const completed = Symbol("completed");
  const failure = await runTopPlaylistCreationWithReservedDownstream(
    createOperationDeadline(27_002, { now: () => 0 }),
    async () => {
      throw error;
    },
    async () => undefined
  ).then(
    () => completed,
    (creationFailure: unknown) => creationFailure
  );
  assert.notEqual(failure, completed);
  return failure;
}

test("top-playlist refresh uses the shared Spotify provider lease key", () => {
  assert.equal(
    SPOTIFY_SYNC_LEASE_KEY,
    makeIntegrationSyncLeaseKey("spotify")
  );
});

test("managed playlist descriptions use deterministic Eastern timestamps", () => {
  assert.equal(
    formatManagedPlaylistDescription(
      new Date("2026-07-19T00:48:00.000Z")
    ),
    `${PLAYLIST_DESCRIPTION_BASE} Updated: Jul 18, 2026, 8:48 PM EDT`
  );
  assert.equal(
    formatManagedPlaylistDescription(
      new Date("2026-01-19T01:05:00.000Z")
    ),
    `${PLAYLIST_DESCRIPTION_BASE} Updated: Jan 18, 2026, 8:05 PM EST`
  );
});

test("managed playlist discovery ignores matching foreign playlists", () => {
  const name = "My Top Songs · Last 4 Weeks";
  const description = `${PLAYLIST_DESCRIPTION_BASE} Updated: Jul 18, 2026, 8:48 PM EDT`;
  const selected = selectOwnedManagedPlaylist(
    [
      {
        id: "a-foreign-collaborative",
        name,
        description,
        collaborative: true,
        owner: { id: "other-user" },
      },
      {
        id: "b-followed-foreign",
        name,
        description,
        owner: { id: "followed-owner" },
      },
      {
        id: "c-unrelated-owned",
        name,
        description: "A personal playlist with the same name.",
        owner: { id: "current-user" },
      },
      {
        id: "d-owned",
        name,
        description,
        owner: { id: "current-user" },
      },
      {
        id: "e-owner-omitted",
        name,
        description,
      },
    ],
    "current-user"
  );

  assert.equal(selected?.id, "d-owned");
});

test("managed playlist discovery accepts legacy managed descriptions", () => {
  const selected = selectOwnedManagedPlaylist(
    [
      {
        id: "managed",
        name: "My Top Songs · Last 4 Weeks",
        description:
          "Auto-updated every morning — my top tracks from the last 4 weeks (via stats.fm). Last updated: Jul 18, 2026, 8:48 PM EDT.",
        owner: { id: "current-user" },
      },
    ],
    "current-user"
  );

  assert.equal(selected?.id, "managed");
});

test("stored playlists are ownership-validated before replacement", () => {
  const source = readFileSync(
    new URL("./topPlaylist.ts", import.meta.url),
    "utf8"
  );
  const currentUserRead = source.indexOf("getCurrentSpotifyUserId");
  const storedDecision = source.indexOf(
    'if (decision.kind === "stored")'
  );
  const ownershipValidation = source.indexOf(
    "await playlistOwnedByUser(",
    storedDecision
  );
  const missingOrForeignCleanup = source.indexOf(
    "await clearMissingStoredPlaylist(",
    ownershipValidation
  );
  const replacement = source.indexOf(
    "replacePlaylistItems(",
    ownershipValidation
  );

  assert.ok(currentUserRead >= 0);
  assert.ok(ownershipValidation > storedDecision);
  assert.ok(missingOrForeignCleanup > ownershipValidation);
  assert.ok(replacement > ownershipValidation);
  assert.doesNotMatch(
    source.slice(storedDecision, missingOrForeignCleanup),
    /playlistExists/
  );
});

test("lost Spotify leases become structured stale results", () => {
  assert.deepEqual(
    asTopPlaylistLeaseStaleResult(
      new IntegrationSyncLeaseLostError(SPOTIFY_SYNC_LEASE_KEY)
    ),
    {
      ok: false,
      status: "stale",
      reason: "lease_lost",
      leaseKey: SPOTIFY_SYNC_LEASE_KEY,
    }
  );
  assert.equal(asTopPlaylistLeaseStaleResult(new Error("provider failed")), null);
});

test("top-playlist state transactions share the operation deadline", () => {
  const source = readFileSync(
    new URL("./topPlaylist.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /runDeadlineBoundTransaction\(/);
  assert.match(source, /TOP_PLAYLIST_TRANSACTION_MIN_TIMEOUT_MS = 5_000/);
  assert.match(
    source,
    /TOP_PLAYLIST_FRESHNESS_TRANSACTION = topPlaylistTransaction\(\s*"Top-playlist freshness persistence"/
  );
  assert.doesNotMatch(
    source,
    /\{\s*maxWait:\s*15_000,\s*timeout:\s*30_000\s*\}/
  );
});

test("top-playlist replacement reserves the deterministic freshness boundary", async () => {
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };
  assert.equal(minimumTopPlaylistFreshnessRemainingMs(), 6_001);
  assert.equal(minimumTopPlaylistExternalWriteRemainingMs(), 16_001);

  let externalWrites = 0;
  await assert.rejects(
    runTopPlaylistExternalWriteAndFreshness(
      createOperationDeadline(16_000, { now: () => 0 }),
      async () => {
        externalWrites++;
        return result;
      },
      async () => undefined
    ),
    OperationDeadlineExceededError
  );
  assert.equal(externalWrites, 0);

  let nowMs = 0;
  const exactDeadline = createOperationDeadline(16_001, {
    now: () => nowMs,
  });
  assert.equal(
    await runTopPlaylistExternalWriteAndFreshness(
      exactDeadline,
      async (writeDeadline) => {
        assert.equal(remainingOperationTimeMs(writeDeadline), 10_000);
        externalWrites++;
        nowMs += 10_000;
        return result;
      },
      async () => {
        assertOperationTimeRemaining(
          exactDeadline,
          minimumTopPlaylistFreshnessRemainingMs(),
          "Top-playlist freshness persistence"
        );
      }
    ),
    result
  );
  assert.equal(externalWrites, 1);
});

test("playlist creation reserves ID persistence, replacement, and freshness before dispatch", async () => {
  assert.equal(minimumTopPlaylistCreationRemainingMs(), 27_002);
  let creationCalls = 0;
  await assert.rejects(
    runTopPlaylistCreationWithReservedDownstream(
      createOperationDeadline(27_001, { now: () => 0 }),
      async () => {
        creationCalls++;
        return { id: "created", url: "https://example.com/created" };
      },
      async () => undefined
    ),
    OperationDeadlineExceededError
  );
  assert.equal(creationCalls, 0);

  let nowMs = 0;
  const deadline = createOperationDeadline(27_002, {
    now: () => nowMs,
  });
  const created = await runTopPlaylistCreationWithReservedDownstream(
    deadline,
    async (creationDeadline) => {
      assert.equal(remainingOperationTimeMs(creationDeadline), 5_000);
      creationCalls++;
      nowMs += 5_000;
      return { id: "created", url: "https://example.com/created" };
    },
    async (_playlist, persistenceDeadline) => {
      assert.equal(remainingOperationTimeMs(persistenceDeadline), 6_001);
      nowMs += 6_001;
    }
  );

  assert.equal(created.id, "created");
  assert.equal(creationCalls, 1);
  assert.equal(
    remainingOperationTimeMs(deadline),
    minimumTopPlaylistExternalWriteRemainingMs()
  );
});

test("pre-dispatch creation budget failures release the claim as deferred", () => {
  const error = new OperationDeadlineExceededError(
    "Spotify POST /v1/me/playlists request",
    5_000,
    4_999,
    10_000
  );

  assert.deepEqual(classifyTopPlaylistCreationFailure(error), {
    disposition: "deferred",
    claimAction: "release",
    claimQuarantineMs: 0,
    creationDispatched: false,
    externalMutationMayHaveCompleted: false,
    priorSnapshotPreserved: true,
    providerStatus: null,
    retryAfterMs: null,
  });
});

test("a deferred 429 retry budget releases the creation claim", () => {
  const error = new DeferredRetryError(30_000, 4_000);

  assert.deepEqual(classifyTopPlaylistCreationFailure(error), {
    disposition: "deferred",
    claimAction: "release",
    claimQuarantineMs: 0,
    creationDispatched: true,
    externalMutationMayHaveCompleted: false,
    priorSnapshotPreserved: true,
    providerStatus: null,
    retryAfterMs: 30_000,
  });
});

test("definitive Spotify 400 creation failures are permanent and non-mutating", async () => {
  const error = new SpotifyApiError(400, "invalid request", null);

  assert.equal(await captureCreationFailure(error), error);
  assert.deepEqual(classifyTopPlaylistCreationFailure(error), {
    disposition: "permanent",
    claimAction: "release",
    claimQuarantineMs: 0,
    creationDispatched: true,
    externalMutationMayHaveCompleted: false,
    priorSnapshotPreserved: true,
    providerStatus: 400,
    retryAfterMs: null,
  });
});

test("Spotify 401 and 403 creation failures release the claim permanently", async () => {
  for (const status of [401, 403]) {
    const error = new SpotifyApiError(status, "authorization denied", null);
    assert.equal(await captureCreationFailure(error), error);
    const classification = classifyTopPlaylistCreationFailure(error);
    assert.equal(classification.disposition, "permanent");
    assert.equal(classification.claimAction, "release");
    assert.equal(classification.priorSnapshotPreserved, true);
    assert.equal(classification.providerStatus, status);
  }
});

test("an explicit Spotify 429 creation response is retryable and non-mutating", async () => {
  const error = new SpotifyApiError(429, "rate limited", 15_000);

  assert.equal(await captureCreationFailure(error), error);
  assert.deepEqual(classifyTopPlaylistCreationFailure(error), {
    disposition: "retryable",
    claimAction: "release",
    claimQuarantineMs: 0,
    creationDispatched: true,
    externalMutationMayHaveCompleted: false,
    priorSnapshotPreserved: true,
    providerStatus: 429,
    retryAfterMs: 15_000,
  });
});

test("Spotify 5xx creation responses quarantine the claim for ten minutes", async () => {
  const error = new SpotifyApiError(503, "unavailable", null);
  const failure = await captureCreationFailure(error);

  assert.ok(failure instanceof TopPlaylistCreationOutcomeUncertainError);
  assert.equal(failure.creationFailure, error);
  assert.deepEqual(classifyTopPlaylistCreationFailure(error), {
    disposition: "uncertain",
    claimAction: "quarantine",
    claimQuarantineMs: 10 * 60 * 1_000,
    creationDispatched: true,
    externalMutationMayHaveCompleted: true,
    priorSnapshotPreserved: false,
    providerStatus: 503,
    retryAfterMs: null,
  });
});

test("a timeout after playlist creation dispatch is uncertain", async () => {
  const error = Object.assign(new Error("request timed out"), {
    name: "TimeoutError",
  });
  const failure = await captureCreationFailure(error);

  assert.ok(failure instanceof TopPlaylistCreationOutcomeUncertainError);
  assert.equal(failure.creationFailure, error);
  assert.equal(
    classifyTopPlaylistCreationFailure(error).claimAction,
    "quarantine"
  );
});

test("a connection reset during playlist creation is uncertain", async () => {
  const error = Object.assign(new Error("socket reset"), {
    code: "ECONNRESET",
  });
  const failure = await captureCreationFailure(error);

  assert.ok(failure instanceof TopPlaylistCreationOutcomeUncertainError);
  assert.equal(failure.creationFailure, error);
  assert.equal(
    classifyTopPlaylistCreationFailure(error).claimQuarantineMs,
    10 * 60 * 1_000
  );
});

test("a dispatched creation with a lost response is explicitly uncertain", () => {
  const deadline = createOperationDeadline(22_002, { now: () => 0 });
  const failure = new TopPlaylistCreationOutcomeUncertainError(
    Object.assign(new Error("connection lost"), { name: "AbortError" }),
    new OperationDeadlineExceededError(
      "Spotify playlist creation recovery",
      5_000,
      1_000,
      deadline.expiresAtMs
    )
  );

  const partial = asTopPlaylistExternalWritePartialResult(
    failure,
    deadline
  );

  assert.equal(partial?.reason, "playlist_creation_outcome_uncertain");
  if (partial?.reason === "playlist_creation_outcome_uncertain") {
    assert.equal(partial.details.creationDispatched, true);
    assert.equal(partial.details.playlistCreated, null);
    assert.equal(partial.details.playlistId, null);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.deadline?.cause, "operation_deadline");
  }
  assert.equal(
    JSON.stringify(partial).includes('"priorSnapshotPreserved":true'),
    false
  );
});

test("a known created playlist ID survives persistence failure", async () => {
  const deadline = createOperationDeadline(27_002, { now: () => 0 });
  const data: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "created-playlist",
    playlistUrl: "https://open.spotify.com/playlist/created-playlist",
    created: true,
  };
  let failure: unknown;
  try {
    await runTopPlaylistCreationWithReservedDownstream(
      deadline,
      async () => data,
      async () => {
        throw new DeadlineTransactionTimeoutError(
          "Top-playlist creation finalization",
          6_001,
          1_000,
          deadline.expiresAtMs,
          true
        );
      }
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof TopPlaylistCreatedIncompleteError);

  const partial = asTopPlaylistExternalWritePartialResult(
    failure,
    deadline
  );

  assert.equal(partial?.reason, "created_playlist_incomplete");
  if (partial?.reason === "created_playlist_incomplete") {
    assert.equal(partial.data.playlistId, "created-playlist");
    assert.equal(partial.details.creationCompleted, true);
    assert.equal(partial.details.replacementCompleted, false);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.deadline?.cause, "transaction_timeout");
  }
});

test("post-write freshness failures report an explicit partial state", async () => {
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };
  let nowMs = 0;
  const deadline = createOperationDeadline(16_001, { now: () => nowMs });
  let failure: unknown;
  try {
    await runTopPlaylistExternalWriteAndFreshness(
      deadline,
      async (writeDeadline) => {
        assert.equal(remainingOperationTimeMs(writeDeadline), 10_000);
        nowMs += 10_000;
        return result;
      },
      async () => {
        throw new DeadlineTransactionTimeoutError(
          "Top-playlist freshness persistence",
          minimumTopPlaylistFreshnessRemainingMs(),
          remainingOperationTimeMs(deadline),
          deadline.expiresAtMs,
          false
        );
      }
    );
  } catch (error) {
    failure = error;
  }

  const partial = asTopPlaylistExternalWritePartialResult(failure, deadline);
  assert.equal(partial?.status, "partial");
  assert.equal(
    partial?.reason,
    "external_write_completed_freshness_not_persisted"
  );
  if (
    partial?.reason ===
    "external_write_completed_freshness_not_persisted"
  ) {
    assert.equal(partial.details.externalWriteCompleted, true);
    assert.equal(partial.details.freshnessPersisted, false);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.deadline?.remainingMs, 6_001);
  }
  assert.equal(
    JSON.stringify(partial).includes('"priorSnapshotPreserved":true'),
    false
  );
});

test("ambiguous playlist PUT failures never advance freshness or claim preservation", async () => {
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };
  const deadline = createOperationDeadline(16_001, { now: () => 0 });
  const failure = new TopPlaylistExternalWriteUncertainError(
    result,
    new SpotifyPlaylistMutationUncertainError(
      "playlist",
      1,
      Object.assign(new Error("connection lost"), { name: "AbortError" })
    )
  );
  let freshnessWrites = 0;
  await assert.rejects(
    runTopPlaylistExternalWriteAndFreshness(
      deadline,
      async () => {
        throw failure;
      },
      async () => {
        freshnessWrites++;
      }
    ),
    (error) => error === failure
  );
  assert.equal(freshnessWrites, 0);

  const partial = asTopPlaylistExternalWritePartialResult(
    failure,
    deadline
  );

  assert.equal(partial?.status, "partial");
  assert.equal(partial?.reason, "external_write_outcome_uncertain");
  if (partial?.reason === "external_write_outcome_uncertain") {
    assert.equal(partial.details.externalWriteCompleted, null);
    assert.equal(partial.details.externalWriteMayHaveCompleted, true);
    assert.equal(partial.details.freshnessPersisted, false);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.deadline?.cause, "abort_signal");
  }
  assert.equal(
    JSON.stringify(partial).includes('"priorSnapshotPreserved":true'),
    false
  );
});

test("playlist items, description, and freshness update in order", async () => {
  const events: string[] = [];
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };

  await runTopPlaylistExternalWriteAndFreshness(
    createOperationDeadline(16_001, { now: () => 0 }),
    () =>
      runTopPlaylistExternalWrites(
        result,
        async () => {
          events.push("items");
        },
        async () => {
          events.push("description");
        }
      ),
    async () => {
      events.push("freshness");
    }
  );

  assert.deepEqual(events, ["items", "description", "freshness"]);
});

test("definitive description failure is partial and does not persist freshness", async () => {
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };
  const deadline = createOperationDeadline(16_001, { now: () => 0 });
  let freshnessWrites = 0;
  let failure: unknown;
  try {
    await runTopPlaylistExternalWriteAndFreshness(
      deadline,
      () =>
        runTopPlaylistExternalWrites(
          result,
          async () => undefined,
          async () => {
            throw new SpotifyApiError(400, "invalid description", null);
          }
        ),
      async () => {
        freshnessWrites++;
      }
    );
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof TopPlaylistDescriptionUpdateFailedError);
  assert.equal(freshnessWrites, 0);
  const partial = asTopPlaylistExternalWritePartialResult(failure, deadline);
  assert.equal(partial?.reason, "playlist_description_update_failed");
  if (partial?.reason === "playlist_description_update_failed") {
    assert.equal(partial.details.itemReplacementCompleted, true);
    assert.equal(partial.details.descriptionUpdateCompleted, false);
    assert.equal(partial.details.descriptionUpdateMayHaveCompleted, false);
    assert.equal(partial.details.freshnessPersisted, false);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.providerStatus, 400);
  }
});

test("uncertain description failure is partial and does not persist freshness", async () => {
  const result: TopPlaylistResult = {
    sourceTracks: 1,
    matchedUris: 1,
    unmatched: [],
    playlistId: "playlist",
    playlistUrl: "https://open.spotify.com/playlist/playlist",
    created: false,
  };
  const deadline = createOperationDeadline(16_001, { now: () => 0 });
  let freshnessWrites = 0;
  let failure: unknown;
  try {
    await runTopPlaylistExternalWriteAndFreshness(
      deadline,
      () =>
        runTopPlaylistExternalWrites(
          result,
          async () => undefined,
          async () => {
            throw new SpotifyPlaylistDetailsMutationUncertainError(
              "playlist",
              Object.assign(new Error("connection lost"), {
                name: "AbortError",
              })
            );
          }
        ),
      async () => {
        freshnessWrites++;
      }
    );
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof TopPlaylistDescriptionUpdateUncertainError);
  assert.equal(freshnessWrites, 0);
  const partial = asTopPlaylistExternalWritePartialResult(failure, deadline);
  assert.equal(
    partial?.reason,
    "playlist_description_update_outcome_uncertain"
  );
  if (
    partial?.reason === "playlist_description_update_outcome_uncertain"
  ) {
    assert.equal(partial.details.itemReplacementCompleted, true);
    assert.equal(partial.details.descriptionUpdateCompleted, null);
    assert.equal(partial.details.descriptionUpdateMayHaveCompleted, true);
    assert.equal(partial.details.freshnessPersisted, false);
    assert.equal(partial.details.priorSnapshotPreserved, false);
    assert.equal(partial.details.deadline?.cause, "abort_signal");
  }
});

test("new playlist creation receives the refresh-attempt description", () => {
  const source = readFileSync(
    new URL("./topPlaylist.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /const description = formatManagedPlaylistDescription\(refreshedAt\)/
  );
  assert.match(
    source,
    /createPlaylist\(\s*PLAYLIST_NAME,\s*description,\s*false/
  );
  assert.ok(
    source.indexOf("await replacePlaylistItems(") <
      source.indexOf("updatePlaylistDescription(")
  );
});

test("top-playlist refresh defers before acquiring the shared lease when time is unsafe", async () => {
  const result = await refreshTopTracksPlaylist(
    50,
    createOperationDeadline(5_000, { now: () => 0 })
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "deferred");
  if (result.status === "deferred") {
    assert.equal(result.details.requiredMs, 6_001);
    assert.equal(result.details.destructiveWorkStarted, false);
    assert.equal(result.details.priorSnapshotPreserved, true);
  }
});
