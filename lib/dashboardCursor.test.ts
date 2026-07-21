import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDashboardCursor,
  encodeDashboardCursor,
  verifyDashboardCursor,
} from "./dashboardCursor";
import {
  DEFAULT_FILTERS,
  type DashboardQuery,
} from "./dashboardQuery";
import {
  buildDashboardSnapshotMembers,
  dashboardQueryKey,
  dashboardSnapshotAccessStatus,
  dashboardSnapshotExpiresAt,
  isDashboardSnapshotExpired,
} from "./dashboardSnapshot";

const query: DashboardQuery = {
  mode: "matched",
  filters: { ...DEFAULT_FILTERS, search: "Four Tet" },
};
const cursor = {
  snapshotId: "snapshot_abc123",
  position: 47,
};
const ownerKey = "a".repeat(64);

test("dashboard snapshot cursors round-trip and reject malformed values", () => {
  const encoded = encodeDashboardCursor(cursor, query, ownerKey);
  const decoded = decodeDashboardCursor(encoded, query);
  assert.equal(decoded?.snapshotId, cursor.snapshotId);
  assert.equal(decoded?.position, cursor.position);
  assert.equal(decoded ? verifyDashboardCursor(decoded, query, ownerKey) : false, true);
  assert.equal(
    decoded
      ? verifyDashboardCursor(decoded, query, "b".repeat(64))
      : true,
    false
  );
  assert.equal(
    decoded
      ? verifyDashboardCursor(
          { ...decoded, position: decoded.position + 1 },
          query,
          ownerKey
        )
      : true,
    false
  );
  assert.equal(decodeDashboardCursor(`${encoded}!`, query), null);
  assert.equal(decodeDashboardCursor("not-json", query), null);
  assert.throws(() =>
    encodeDashboardCursor(
      { snapshotId: "snapshot", position: -1 },
      query,
      ownerKey
    )
  );
});

test("dashboard cursor and query hashes reset when filters change", () => {
  const encoded = encodeDashboardCursor(cursor, query, ownerKey);
  const changed = {
    ...query,
    filters: { ...query.filters, search: "Bicep" },
  };
  assert.equal(decodeDashboardCursor(encoded, changed), null);
  assert.notEqual(dashboardQueryKey(query), dashboardQueryKey(changed));
});

test("snapshot membership remains complete when live show dates change", () => {
  const rows = [
    { id: "a", date: new Date("2026-08-01T00:00:00.000Z") },
    { id: "b", date: new Date("2026-08-01T00:00:00.000Z") },
    { id: "c", date: new Date("2026-08-02T00:00:00.000Z") },
  ];
  const members = buildDashboardSnapshotMembers(rows);

  rows[0].date = new Date("2026-09-01T00:00:00.000Z");
  rows[2].date = new Date("2026-07-25T00:00:00.000Z");

  assert.deepEqual(
    members.map(({ position, showId, sortDate }) => ({
      position,
      showId,
      sortDate: sortDate.toISOString(),
    })),
    [
      {
        position: 0,
        showId: "a",
        sortDate: "2026-08-01T00:00:00.000Z",
      },
      {
        position: 1,
        showId: "b",
        sortDate: "2026-08-01T00:00:00.000Z",
      },
      {
        position: 2,
        showId: "c",
        sortDate: "2026-08-02T00:00:00.000Z",
      },
    ]
  );
  assert.deepEqual(
    members.filter((member) => member.position > 0).map((member) => member.showId),
    ["b", "c"]
  );
});

test("dashboard snapshots have a bounded expiry", () => {
  const createdAt = new Date("2026-07-21T03:00:00.000Z");
  const expiresAt = dashboardSnapshotExpiresAt(createdAt);
  assert.equal(isDashboardSnapshotExpired(expiresAt, createdAt), false);
  assert.equal(isDashboardSnapshotExpired(expiresAt, expiresAt), true);
});

test("cleaned and never-existing signed snapshots use gone recovery semantics", () => {
  const now = new Date("2026-07-21T03:00:00.000Z");
  const ownerKey = "a".repeat(64);
  const missingCursor = decodeDashboardCursor(
    encodeDashboardCursor(
      { snapshotId: "deleted_snapshot", position: 0 },
      query,
      ownerKey
    ),
    query
  );
  assert.equal(
    missingCursor
      ? verifyDashboardCursor(missingCursor, query, ownerKey)
      : false,
    true
  );
  assert.equal(
    dashboardSnapshotAccessStatus(
      null,
      query,
      ownerKey,
      missingCursor?.position ?? -1,
      now
    ),
    "expired"
  );
  assert.equal(
    dashboardSnapshotAccessStatus(
      {
        ownerKey,
        queryKey: dashboardQueryKey(query),
        total: 10,
        expiresAt: now,
      },
      query,
      ownerKey,
      0,
      now
    ),
    "expired"
  );
});

test("wrong owner, query, and out-of-range cursors remain invalid", () => {
  const now = new Date("2026-07-21T03:00:00.000Z");
  const ownerKey = "a".repeat(64);
  const snapshot = {
    ownerKey,
    queryKey: dashboardQueryKey(query),
    total: 10,
    expiresAt: new Date("2026-07-21T04:00:00.000Z"),
  };
  assert.equal(
    dashboardSnapshotAccessStatus(snapshot, query, "b".repeat(64), 0, now),
    "invalid"
  );
  assert.equal(
    dashboardSnapshotAccessStatus(
      snapshot,
      { ...query, filters: { ...query.filters, search: "Bicep" } },
      ownerKey,
      0,
      now
    ),
    "invalid"
  );
  assert.equal(
    dashboardSnapshotAccessStatus(snapshot, query, ownerKey, 10, now),
    "invalid"
  );
});
