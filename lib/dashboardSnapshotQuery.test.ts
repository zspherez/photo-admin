import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./match.ts", import.meta.url), "utf8");

test("dashboard snapshot creation freezes ordered membership transactionally", () => {
  const create = source.slice(
    source.indexOf("async function createDashboardSnapshot"),
    source.indexOf("async function loadDashboardSnapshotBatch")
  );
  assert.match(create, /TransactionIsolationLevel\.RepeatableRead/);
  assert.match(create, /orderBy: \[\{ date: "asc" \}, \{ id: "asc" \}\]/);
  assert.ok(
    create.indexOf("transaction.show.findMany") <
      create.indexOf("dashboardShowSnapshotMember.createMany")
  );
  assert.match(create, /buildDashboardSnapshotMembers\(orderedShows\)/);
});

test("subsequent batches validate owner, query, expiry, and position", () => {
  const next = source.slice(source.indexOf("export async function getDashboardNextBatch"));
  assert.match(next, /snapshot\.ownerKey !== ownerKey/);
  assert.match(next, /snapshot\.queryKey !== dashboardQueryKey\(query\)/);
  assert.match(next, /verifyDashboardCursor\(cursor, query, snapshot\.cursorKey\)/);
  assert.match(next, /isDashboardSnapshotExpired/);
  assert.match(next, /cursor\.position >= snapshot\.total/);
  assert.match(
    source,
    /dashboardShowSnapshotMember\.findMany\(\{[\s\S]*position: \{ gt: afterPosition \}[\s\S]*orderBy: \{ position: "asc" \}/
  );
  assert.doesNotMatch(source, /showId:\s*\{\s*in:/);
  assert.equal(
    source.match(/loadDashboardSnapshotBatch\(/g)?.length,
    3,
    "definition, initial load, and subsequent load must share one batch helper"
  );
});
