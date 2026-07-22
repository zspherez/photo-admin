import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260722050000_contact_research_candidate_superseded_status/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("candidate status migration permits superseded approvals", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(
    migration,
    /DROP CONSTRAINT "ContactResearchCandidate_status_check"/,
  );
  assert.match(
    migration,
    /"status" IN \(\s*'pending',\s*'approved',\s*'rejected',\s*'superseded'\s*\)/,
  );
  assert.match(migration, /COMMIT;\s*$/);
});
