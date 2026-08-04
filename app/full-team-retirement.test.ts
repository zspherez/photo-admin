import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("live full-team contact behavior and UI are retired", () => {
  const selection = source("lib/contactSelection.ts");
  const send = source("lib/sendOutreach.ts");
  assert.doesNotMatch(selection, /isFullTeam/);
  assert.doesNotMatch(send, /contact\.isFullTeam/);
  for (const file of [
    "components/artist-modal.tsx",
    "app/artists/[id]/page.tsx",
    "app/festivals/[showId]/page.tsx",
    "app/dashboard/dashboard-client.tsx",
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  ]) {
    assert.doesNotMatch(source(file), /Full team|full-team|isFullTeam/, file);
  }
});

test("retirement migration clears and permanently disables the database flag", () => {
  const migration = source(
    "prisma/migrations/20260804033000_retire_contact_full_team/migration.sql",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /UPDATE "Contact"[\s\S]*SET "isFullTeam" = false/);
  assert.match(migration, /Contact_isFullTeam_retired_check/);
  assert.match(migration, /CHECK \("isFullTeam" = false\)/);
  assert.match(migration, /ADD COLUMN "headers" JSONB/);
  assert.match(migration, /ADD COLUMN "formatVersion" INTEGER/);
  assert.match(
    migration,
    /DISABLE TRIGGER "ContactExportSnapshot_guard_update"[\s\S]*UPDATE "ContactExportSnapshot"[\s\S]*ENABLE TRIGGER "ContactExportSnapshot_guard_update"/,
  );
  assert.match(migration, /ALTER COLUMN "headers" SET NOT NULL/);
  assert.match(migration, /ContactAuditJob_resolvedContactId_idx/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});

test("new snapshots omit full-team and include research and audit evidence", () => {
  const snapshot = source("lib/contactSnapshot.ts");
  assert.match(
    snapshot,
    /CONTACT_SNAPSHOT_VISIBLE_HEADERS = \[\s*"artist_name",\s*"name",\s*"role",\s*"email",\s*"phone",\s*"direct_outreach",\s*"source",\s*"created_at",\s*"updated_at"/,
  );
  assert.doesNotMatch(
    snapshot.slice(
      snapshot.indexOf("export const CONTACT_SNAPSHOT_HEADERS"),
      snapshot.indexOf("] as const;", snapshot.indexOf("export const CONTACT_SNAPSHOT_HEADERS")),
    ),
    /full_team/,
  );
  for (const header of [
    "research_evidence",
    "research_source_urls",
    "audit_finding",
    "audit_evidence",
    "audit_source_urls",
    "audit_verified_at",
  ]) {
    assert.match(snapshot, new RegExp(`"${header}"`));
  }
  assert.match(snapshot, /status: "approved"/);
  assert.match(snapshot, /audit_job\."verifiedAt" IS NOT NULL/);
  assert.match(snapshot, /SELECT DISTINCT ON/);
  assert.match(
    snapshot,
    /"resolvedContactId" = ANY\(\$\{contactIds\}::text\[\]\)/,
  );
  assert.doesNotMatch(snapshot, /Prisma\.join\(contactIds\)/);
  const exporter = source("lib/googleSheetContactExport.ts");
  assert.match(exporter, /properties: \{ hiddenByUser: range\.hiddenByUser \}/);
});
