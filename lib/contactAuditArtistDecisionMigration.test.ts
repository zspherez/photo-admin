import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260722210000_contact_audit_artist_decisions/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const contactDeletionMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260924125000_allow_audited_contact_deletion/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("artist audit decisions are normalized, constrained, and immutable", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TABLE "ContactAuditArtistDecision"/);
  assert.match(migration, /CREATE TABLE "ContactAuditDecisionContact"/);
  assert.match(
    migration,
    /"action" IN \([\s\S]*'append'[\s\S]*'replace_selected'[\s\S]*'deactivate_selected'[\s\S]*'rejected'/,
  );
  assert.match(
    migration,
    /ContactAuditArtistDecision_runId_artistId_key/,
  );
  assert.match(
    migration,
    /Selected contact audit alternative must belong to the artist audit/,
  );
  assert.match(
    migration,
    /Artist contact audit decisions require complete unclaimed jobs/,
  );
  assert.match(
    migration,
    /Artist-level contact audit decision already exists/,
  );
  assert.match(
    migration,
    /Contact audit decision contact must belong to the immutable artist roster/,
  );
  assert.match(
    migration,
    /DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    migration,
    /Contact audit decision contacts are sealed/,
  );
  assert.match(
    migration,
    /ContactAuditDecisionContact_seal_insert/,
  );
  assert.match(
    migration,
    /Contact audit artist decisions are immutable/,
  );
  assert.match(migration, /COMMIT;\s*$/);
});

test("Prisma exposes artist decisions and selected contact provenance", () => {
  assert.match(schema, /model ContactAuditArtistDecision \{/);
  assert.match(schema, /model ContactAuditDecisionContact \{/);
  assert.match(
    schema,
    /contactAuditDecisions ContactAuditArtistDecision\[\]/,
  );
  assert.match(schema, /createdContactId\s+String\?/);
  assert.match(schema, /contactId\s+String/);
  assert.doesNotMatch(schema, /createdContact\s+Contact\?/);
  assert.doesNotMatch(schema, /auditDecisionMutations ContactAuditDecisionContact\[\]/);
});

test("deleting a contact preserves immutable audit identifiers and snapshots", () => {
  assert.match(contactDeletionMigration, /^BEGIN;/);
  assert.match(
    contactDeletionMigration,
    /DROP CONSTRAINT "ContactAuditArtistDecision_createdContactId_fkey"/,
  );
  assert.match(
    contactDeletionMigration,
    /DROP CONSTRAINT "ContactAuditDecisionContact_contactId_fkey"/,
  );
  assert.doesNotMatch(contactDeletionMigration, /DELETE FROM|UPDATE "ContactAudit/);
  assert.match(migration, /ContactAuditArtistDecision_immutable_delete/);
  assert.match(migration, /ContactAuditDecisionContact_immutable_delete/);
  assert.match(contactDeletionMigration, /COMMIT;\s*$/);
});
