import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  monitorRequiredSyncResult,
  syncListensHttpStatus,
} from "./route";

test("incomplete Spotify reconciliation is promoted to cron failure", () => {
  const monitored = monitorRequiredSyncResult({
    ok: true,
    durationMs: 42,
    data: {
      ok: false as const,
      status: "partial" as const,
      reason: "playlist_reconciliation_incomplete",
      details: {
        stalePlaylistDataPreserved: true,
        playlists: [{ playlistId: "private", state: "forbidden" }],
      },
    },
  });

  assert.equal(monitored.ok, false);
  assert.equal(
    syncListensHttpStatus([monitored]),
    500
  );
  if (!monitored.ok && "data" in monitored) {
    assert.equal(monitored.data.status, "partial");
    assert.equal(
      monitored.data.details.stalePlaylistDataPreserved,
      true
    );
  }
});

test("lease conflicts remain structured and return HTTP conflict", () => {
  const monitored = monitorRequiredSyncResult({
    ok: true,
    durationMs: 5,
    data: {
      ok: false as const,
      status: "busy" as const,
      reason: "lease_conflict" as const,
      leaseKey: "integration-sync:spotify:W10",
      expiresAt: "2026-07-16T12:00:00.000Z",
      retryAfterMs: 10_000,
    },
  });

  assert.equal(syncListensHttpStatus([monitored]), 409);
  assert.deepEqual(
    !monitored.ok && "data" in monitored
      ? {
          status: monitored.data.status,
          leaseKey: monitored.data.leaseKey,
        }
      : null,
    {
      status: "busy",
      leaseKey: "integration-sync:spotify:W10",
    }
  );
});

test("listen cron does not read or synchronize contact Sheets", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /sheet/i);
  assert.match(source, /const results = \{ spotify, statsfm \}/);
});
