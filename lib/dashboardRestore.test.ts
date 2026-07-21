import assert from "node:assert/strict";
import test from "node:test";
import {
  createDashboardRestoreState,
  dashboardRestoreIntentStorageKey,
  dashboardRestoreStorageKey,
  hasDashboardRestoreIntent,
  parseDashboardRestoreState,
} from "./dashboardRestore";

const scope = "a".repeat(64);
const now = Date.parse("2026-07-21T03:00:00.000Z");

test("dashboard restore state preserves bounded depth and scroll anchor", () => {
  const state = createDashboardRestoreState({
    batches: 5,
    snapshotId: "snapshot_1",
    nextCursor: "cursor_1",
    anchorId: "show_123",
    anchorOffset: 48,
    scrollY: 3200,
    savedAt: now,
  });
  assert.deepEqual(
    parseDashboardRestoreState(JSON.stringify(state), now),
    state
  );
});

test("browser returns and action redirects restore, while filters and sessions reset", () => {
  const fourTet = dashboardRestoreStorageKey(
    scope,
    "/dashboard?search=Four+Tet"
  );
  const bicep = dashboardRestoreStorageKey(scope, "/dashboard?search=Bicep");
  assert.notEqual(fourTet, bicep);
  assert.notEqual(
    dashboardRestoreStorageKey(scope, "/dashboard"),
    dashboardRestoreStorageKey("b".repeat(64), "/dashboard")
  );
  assert.notEqual(
    dashboardRestoreIntentStorageKey(scope),
    dashboardRestoreIntentStorageKey("b".repeat(64))
  );
  assert.equal(hasDashboardRestoreIntent(fourTet, fourTet, null), true);
  assert.equal(hasDashboardRestoreIntent(fourTet, null, fourTet), true);
  assert.equal(hasDashboardRestoreIntent(fourTet, bicep, bicep), false);
});

test("corrupted, oversized, and stale restore state is rejected", () => {
  assert.equal(parseDashboardRestoreState("{", now), null);
  assert.equal(
    parseDashboardRestoreState(
      JSON.stringify({
        v: 1,
        batches: 999,
        snapshotId: "snapshot_1",
        nextCursor: null,
        anchorId: null,
        anchorOffset: 0,
        scrollY: 0,
        savedAt: now,
      }),
      now
    ),
    null
  );
  const stale = createDashboardRestoreState({
    batches: 2,
    snapshotId: "snapshot_1",
    nextCursor: "cursor_1",
    anchorId: null,
    anchorOffset: 0,
    scrollY: 20,
    savedAt: now - 25 * 60 * 60 * 1000,
  });
  assert.equal(parseDashboardRestoreState(JSON.stringify(stale), now), null);
});
