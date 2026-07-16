import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOperationDeadline } from "./integrationUtils";
import { syncStatsfmTopArtistRanges } from "./statsfm";

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
