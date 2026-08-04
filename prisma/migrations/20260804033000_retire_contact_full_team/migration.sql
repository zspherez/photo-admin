BEGIN;

UPDATE "Contact"
SET "isFullTeam" = false
WHERE "isFullTeam" = true;

ALTER TABLE "Contact"
ADD CONSTRAINT "Contact_isFullTeam_retired_check"
CHECK ("isFullTeam" = false);

ALTER TABLE "ContactExportSnapshot"
  ADD COLUMN "formatVersion" INTEGER,
  ADD COLUMN "headers" JSONB;

ALTER TABLE "ContactExportSnapshot"
DISABLE TRIGGER "ContactExportSnapshot_guard_update";

UPDATE "ContactExportSnapshot"
SET
  "formatVersion" = 1,
  "headers" = '[
  "snapshot_timestamp",
  "snapshot_id",
  "contact_id",
  "artist_id",
  "artist_name",
  "contact_state",
  "name",
  "role",
  "email",
  "phone",
  "direct_outreach_note",
  "full_team",
  "custom_price",
  "notes",
  "source",
  "source_key",
  "source_sync_timestamp",
  "created_at",
  "updated_at"
]'::jsonb;

ALTER TABLE "ContactExportSnapshot"
  ALTER COLUMN "formatVersion" SET NOT NULL,
  ALTER COLUMN "headers" SET NOT NULL;

ALTER TABLE "ContactExportSnapshot"
ENABLE TRIGGER "ContactExportSnapshot_guard_update";

ALTER TABLE "ContactExportSnapshot"
ADD CONSTRAINT "ContactExportSnapshot_formatVersion_check"
CHECK ("formatVersion" IN (1, 2));

CREATE INDEX "ContactAuditJob_resolvedContactId_idx"
ON "ContactAuditJob"("resolvedContactId");

COMMIT;
