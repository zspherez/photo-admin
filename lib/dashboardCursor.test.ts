import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeDashboardCursor,
  encodeDashboardCursor,
} from "./dashboardCursor";
import {
  DEFAULT_FILTERS,
  type DashboardQuery,
} from "./dashboardQuery";
import { buildDashboardShowFindManyArgs } from "./match";

const query: DashboardQuery = {
  mode: "matched",
  filters: { ...DEFAULT_FILTERS, search: "Four Tet" },
};
const snapshotAt = new Date("2026-07-20T22:00:00.000Z");
const cursor = {
  date: new Date("2026-08-01T00:00:00.000Z"),
  id: "show_abc123",
  snapshotAt,
};

test("dashboard cursors round-trip and reject malformed values", () => {
  const encoded = encodeDashboardCursor(cursor, query);
  assert.deepEqual(
    decodeDashboardCursor(
      encoded,
      query,
      new Date("2026-07-21T00:00:00.000Z")
    ),
    cursor
  );
  assert.equal(decodeDashboardCursor(`${encoded}!`, query), null);
  assert.equal(decodeDashboardCursor("not-json", query), null);
});

test("dashboard cursor scope resets when filters change", () => {
  const encoded = encodeDashboardCursor(cursor, query);
  assert.equal(
    decodeDashboardCursor(
      encoded,
      {
        ...query,
        filters: { ...query.filters, search: "Bicep" },
      },
      new Date("2026-07-21T00:00:00.000Z")
    ),
    null
  );
});

test("dashboard cursor rejects non-midnight dates and future snapshots", () => {
  assert.throws(() =>
    encodeDashboardCursor(
      { ...cursor, date: new Date("2026-08-01T12:00:00.000Z") },
      query
    )
  );
  const future = encodeDashboardCursor(
    { ...cursor, snapshotAt: new Date("2026-07-21T12:00:00.000Z") },
    query
  );
  assert.equal(
    decodeDashboardCursor(
      future,
      query,
      new Date("2026-07-20T22:00:00.000Z")
    ),
    null
  );
});

test("initial and subsequent dashboard batches share selection and stable order", () => {
  const initial = buildDashboardShowFindManyArgs(query, snapshotAt, null);
  const subsequent = buildDashboardShowFindManyArgs(
    query,
    snapshotAt,
    cursor
  );
  assert.deepEqual(initial.select, subsequent.select);
  assert.deepEqual(initial.orderBy, [
    { date: "asc" },
    { id: "asc" },
  ]);
  assert.equal("skip" in initial, false);
  assert.equal(initial.take, subsequent.take);

  const and = subsequent.where.AND as Array<Record<string, unknown>>;
  assert.deepEqual(and[1], {
    OR: [
      { date: { gt: cursor.date } },
      { date: cursor.date, id: { gt: cursor.id } },
    ],
  });
});
