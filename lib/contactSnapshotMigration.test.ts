import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260723180000_contact_export_snapshots/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("contact export snapshot migration is transactional and constrained", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /CREATE TABLE "ContactExportSnapshot"/);
  assert.match(migration, /ContactExportSnapshot_status_check/);
  assert.match(migration, /ContactExportSnapshot_lifecycle_check/);
  assert.match(migration, /ContactExportSnapshot_contentSha256_check/);
  assert.match(migration, /ContactExportSnapshot_idempotencyKey_key/);
  assert.match(migration, /jsonb_typeof\("canonicalRows"\) = 'array'/);
});

test("completed export metadata and canonical content are immutable", () => {
  assert.match(
    migration,
    /Completed contact export snapshots are immutable/,
  );
  assert.match(
    migration,
    /Contact export snapshot identity and content are immutable/,
  );
  assert.match(
    migration,
    /ContactExportSnapshot_guard_update[\s\S]*BEFORE UPDATE/,
  );
  assert.match(
    migration,
    /ContactExportSnapshot_guard_delete[\s\S]*BEFORE DELETE/,
  );
});
