import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSnapshotCutoff,
  parseSnapshotCursor,
  traverseNewShowSnapshot,
  type NewShowSnapshotCursor,
  type NewShowSnapshotRow,
} from "./new-shows-snapshot";

function descending(
  left: NewShowSnapshotRow,
  right: NewShowSnapshotRow,
): number {
  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  );
}

function afterCursor(
  row: NewShowSnapshotRow,
  cursor: NewShowSnapshotCursor | null,
): boolean {
  if (!cursor) return true;
  return (
    row.createdAt < cursor.createdAt ||
    (row.createdAt.getTime() === cursor.createdAt.getTime() &&
      row.id < cursor.id)
  );
}

test("snapshot traversal paginates past 300 without including concurrent inserts", async () => {
  const cutoff = new Date("2026-07-16T13:00:00.000Z");
  const rows: NewShowSnapshotRow[] = Array.from({ length: 650 }, (_, index) => ({
    id: `show-${String(650 - index).padStart(4, "0")}`,
    createdAt: new Date(cutoff.getTime() - index * 1_000),
  }));
  const visited: string[] = [];
  let calls = 0;

  const traversed = await traverseNewShowSnapshot({
    cutoff,
    fetchPage: async ({ cursor, take }) => {
      calls++;
      if (calls === 2) {
        rows.push({
          id: "concurrent-show",
          createdAt: new Date(cutoff.getTime() + 1),
        });
      }
      const page = rows
        .filter((row) => row.createdAt <= cutoff && afterCursor(row, cursor))
        .sort(descending)
        .slice(0, take);
      visited.push(...page.map((row) => row.id));
      return page;
    },
  });

  assert.equal(traversed, 650);
  assert.equal(calls, 3);
  assert.equal(new Set(visited).size, 650);
  assert.equal(visited.includes("concurrent-show"), false);
});

test("snapshot parsing rejects future, malformed, and unsafe cursor values", () => {
  const now = new Date("2026-07-16T13:00:00.000Z");
  assert.equal(
    parseSnapshotCutoff("2026-07-16T13:00:00.001Z", now),
    null,
  );
  assert.equal(parseSnapshotCutoff("not-a-date", now), null);
  assert.equal(
    parseSnapshotCursor(now.toISOString(), "//example.com", now),
    null,
  );
  assert.deepEqual(
    parseSnapshotCursor(now.toISOString(), "show_123", now),
    { createdAt: now, id: "show_123" },
  );
});
