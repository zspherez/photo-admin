import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260721040000_dashboard_show_snapshots/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("dashboard snapshot migration is transactional and constrained", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /DashboardShowSnapshot_expiry_check/);
  assert.match(migration, /DashboardShowSnapshot_cursorKey_check/);
  assert.match(migration, /DashboardShowSnapshotMember_position_check/);
  assert.match(migration, /DashboardShowSnapshotMember_sortDate_check/);
  assert.match(
    migration,
    /FOREIGN KEY \("showId"\)[\s\S]*ON DELETE RESTRICT/
  );
  assert.match(
    migration,
    /UNIQUE INDEX "DashboardShowSnapshotMember_snapshotId_showId_key"/
  );
});
