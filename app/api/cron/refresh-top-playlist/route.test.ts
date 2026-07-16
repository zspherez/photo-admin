import assert from "node:assert/strict";
import test from "node:test";
import {
  monitorTopPlaylistResult,
  topPlaylistHttpStatus,
} from "./route";

test("top-playlist lease conflicts are structured cron failures", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 10,
    data: {
      ok: false as const,
      status: "busy" as const,
      reason: "lease_conflict" as const,
      leaseKey: "integration-sync:spotify:W10",
      expiresAt: "2026-07-16T12:00:00.000Z",
      retryAfterMs: 10_000,
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 409);
  assert.deepEqual(
    !monitored.ok && "data" in monitored
      ? {
          status: monitored.data.status,
          reason: monitored.data.reason,
          leaseKey:
            monitored.data.status === "busy"
              ? monitored.data.leaseKey
              : null,
        }
      : null,
    {
      status: "busy",
      reason: "lease_conflict",
      leaseKey: "integration-sync:spotify:W10",
    }
  );
});

test("a stale top-playlist worker cannot report success", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 20,
    data: {
      ok: false as const,
      status: "stale" as const,
      reason: "lease_lost" as const,
      leaseKey: "integration-sync:spotify:W10",
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 409);
});

test("top-playlist provider exceptions remain server failures", () => {
  const result = {
    ok: false as const,
    durationMs: 5,
    error: "provider unavailable",
  };

  assert.equal(topPlaylistHttpStatus(result), 500);
});

test("top-playlist deadline deferrals remain retryable server failures", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 25,
    data: {
      ok: false as const,
      status: "deferred" as const,
      reason: "operation_deadline_exceeded" as const,
      details: {
        phase: "Top-playlist freshness persistence",
        operation: "Top-playlist freshness persistence",
        requiredMs: 6_001,
        remainingMs: 2_000,
        destructiveWorkStarted: false,
        transactionStarted: false,
        transactionRolledBack: false,
        priorSnapshotPreserved: true as const,
      },
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 500);
});

test("cron surfaces an uncertain Spotify PUT without reporting success", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 30,
    data: {
      ok: false as const,
      status: "partial" as const,
      reason: "external_write_outcome_uncertain" as const,
      data: {
        sourceTracks: 1,
        matchedUris: 1,
        unmatched: [],
        playlistId: "playlist",
        playlistUrl: "https://open.spotify.com/playlist/playlist",
        created: false,
      },
      details: {
        phase: "external_write" as const,
        externalWriteCompleted: null,
        externalWriteMayHaveCompleted: true as const,
        freshnessPersisted: false as const,
        priorSnapshotPreserved: false as const,
        verification: "not_attempted" as const,
        error: "connection lost",
        playlistId: "playlist",
        deadline: {
          cause: "abort_signal" as const,
          operation: "Spotify playlist replacement",
          requiredMs: 1,
          remainingMs: 0,
          expiresAtMs: 10_000,
          retryAfterMs: null,
          safeExecutionBudgetMs: null,
        },
      },
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 500);
  assert.equal(
    !monitored.ok && "data" in monitored
      ? monitored.data.reason
      : null,
    "external_write_outcome_uncertain"
  );
  assert.equal(
    JSON.stringify(monitored).includes('"priorSnapshotPreserved":true'),
    false
  );
});

test("cron surfaces an uncertain playlist creation without claiming preservation", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 30,
    data: {
      ok: false as const,
      status: "partial" as const,
      reason: "playlist_creation_outcome_uncertain" as const,
      details: {
        phase: "playlist_creation" as const,
        creationDispatched: true as const,
        playlistCreated: null,
        externalMutationMayHaveCompleted: true as const,
        playlistId: null,
        playlistUrl: null,
        replacementCompleted: false as const,
        freshnessPersisted: false as const,
        priorSnapshotPreserved: false as const,
        recovery: "automatic_discovery_incomplete" as const,
        error: "connection lost",
        recoveryError: "recovery deadline exceeded",
        deadline: {
          cause: "operation_deadline" as const,
          operation: "Spotify playlist creation recovery",
          requiredMs: 5_000,
          remainingMs: 1_000,
          expiresAtMs: 10_000,
          retryAfterMs: null,
          safeExecutionBudgetMs: null,
        },
      },
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 500);
  assert.equal(
    !monitored.ok && "data" in monitored
      ? monitored.data.reason
      : null,
    "playlist_creation_outcome_uncertain"
  );
  assert.equal(
    JSON.stringify(monitored).includes('"priorSnapshotPreserved":true'),
    false
  );
});

test("cron preserves a known created playlist ID in recoverable partial state", () => {
  const monitored = monitorTopPlaylistResult({
    ok: true,
    durationMs: 30,
    data: {
      ok: false as const,
      status: "partial" as const,
      reason: "created_playlist_incomplete" as const,
      data: {
        sourceTracks: 1,
        matchedUris: 1,
        unmatched: [],
        playlistId: "created-playlist",
        playlistUrl:
          "https://open.spotify.com/playlist/created-playlist",
        created: true,
      },
      details: {
        phase: "playlist_id_persistence" as const,
        creationCompleted: true as const,
        playlistId: "created-playlist",
        playlistUrl:
          "https://open.spotify.com/playlist/created-playlist",
        replacementCompleted: false as const,
        freshnessPersisted: false as const,
        priorSnapshotPreserved: false as const,
        recovery: "retry_or_reconcile_created_playlist" as const,
        error: "transaction timed out",
        leaseKey: null,
        deadline: {
          cause: "transaction_timeout" as const,
          operation: "Top-playlist creation finalization",
          requiredMs: 6_001,
          remainingMs: 1_000,
          expiresAtMs: 10_000,
          retryAfterMs: null,
          safeExecutionBudgetMs: null,
        },
      },
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(topPlaylistHttpStatus(monitored), 500);
  assert.equal(
    !monitored.ok && "data" in monitored
      ? "data" in monitored.data
        ? monitored.data.data.playlistId
        : null
      : null,
    "created-playlist"
  );
});
