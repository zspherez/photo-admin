BEGIN;

CREATE TABLE "ContactAuditRosterSnapshot" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "snapshotArtistId" TEXT NOT NULL,
  "snapshotArtistName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactAuditRosterSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditRosterSnapshot_artistName_check"
    CHECK (char_length(btrim("snapshotArtistName")) > 0)
);

CREATE TABLE "ContactAuditRosterEntry" (
  "id" TEXT NOT NULL,
  "rosterSnapshotId" TEXT NOT NULL,
  "snapshotContactId" TEXT NOT NULL,
  "snapshotEmail" TEXT,
  "snapshotPhone" TEXT,
  "snapshotDirectOutreachNote" TEXT,
  "snapshotName" TEXT,
  "snapshotRole" TEXT,
  "snapshotSource" TEXT,
  "snapshotNotes" TEXT,
  "snapshotIsFullTeam" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactAuditRosterEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditRosterEntry_contactId_check"
    CHECK (char_length(btrim("snapshotContactId")) > 0)
);

ALTER TABLE "ContactAuditJob"
  ADD COLUMN "rosterSnapshotId" TEXT,
  ADD COLUMN "targetRosterEntryId" TEXT,
  ADD COLUMN "rosterReview" JSONB,
  ADD CONSTRAINT "ContactAuditJob_roster_link_check"
    CHECK (
      ("rosterSnapshotId" IS NULL AND "targetRosterEntryId" IS NULL) OR
      ("rosterSnapshotId" IS NOT NULL AND "targetRosterEntryId" IS NOT NULL)
    ),
  ADD CONSTRAINT "ContactAuditJob_rosterReview_check"
    CHECK (
      "rosterReview" IS NULL OR
      jsonb_typeof("rosterReview") = 'array'
    );

CREATE UNIQUE INDEX "ContactAuditRosterSnapshot_runId_snapshotArtistId_key"
  ON "ContactAuditRosterSnapshot"("runId", "snapshotArtistId");
CREATE INDEX "ContactAuditRosterSnapshot_snapshotArtistId_idx"
  ON "ContactAuditRosterSnapshot"("snapshotArtistId");

CREATE UNIQUE INDEX "ContactAuditRosterEntry_rosterSnapshotId_snapshotContactId_key"
  ON "ContactAuditRosterEntry"("rosterSnapshotId", "snapshotContactId");
CREATE INDEX "ContactAuditRosterEntry_snapshotContactId_idx"
  ON "ContactAuditRosterEntry"("snapshotContactId");
CREATE INDEX "ContactAuditRosterEntry_rosterSnapshotId_email_idx"
  ON "ContactAuditRosterEntry"("rosterSnapshotId", lower("snapshotEmail"))
  WHERE "snapshotEmail" IS NOT NULL;

CREATE UNIQUE INDEX "ContactAuditJob_targetRosterEntryId_key"
  ON "ContactAuditJob"("targetRosterEntryId");
CREATE INDEX "ContactAuditJob_rosterSnapshotId_idx"
  ON "ContactAuditJob"("rosterSnapshotId");

ALTER TABLE "ContactAuditRosterSnapshot"
  ADD CONSTRAINT "ContactAuditRosterSnapshot_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ContactAuditRun"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContactAuditRosterEntry"
  ADD CONSTRAINT "ContactAuditRosterEntry_rosterSnapshotId_fkey"
  FOREIGN KEY ("rosterSnapshotId") REFERENCES "ContactAuditRosterSnapshot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_rosterSnapshotId_fkey"
  FOREIGN KEY ("rosterSnapshotId") REFERENCES "ContactAuditRosterSnapshot"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactAuditJob_targetRosterEntryId_fkey"
  FOREIGN KEY ("targetRosterEntryId") REFERENCES "ContactAuditRosterEntry"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "validate_contact_audit_roster_target"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."rosterSnapshotId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ContactAuditRosterEntry" entry
    JOIN "ContactAuditRosterSnapshot" snapshot
      ON snapshot."id" = entry."rosterSnapshotId"
    WHERE entry."id" = NEW."targetRosterEntryId"
      AND entry."rosterSnapshotId" = NEW."rosterSnapshotId"
      AND snapshot."runId" = NEW."runId"
      AND snapshot."snapshotArtistId" = NEW."artistId"
  ) THEN
    RAISE EXCEPTION 'Contact audit target must belong to the job artist roster snapshot';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditJob_validate_roster_target"
BEFORE INSERT OR UPDATE ON "ContactAuditJob"
FOR EACH ROW
EXECUTE FUNCTION "validate_contact_audit_roster_target"();

CREATE FUNCTION "guard_contact_audit_roster_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Contact audit roster snapshots are immutable';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Contact audit roster snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditRosterSnapshot_immutable_update"
BEFORE UPDATE ON "ContactAuditRosterSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_roster_snapshot"();

CREATE TRIGGER "ContactAuditRosterSnapshot_immutable_delete"
BEFORE DELETE ON "ContactAuditRosterSnapshot"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_roster_snapshot"();

CREATE TRIGGER "ContactAuditRosterEntry_immutable_update"
BEFORE UPDATE ON "ContactAuditRosterEntry"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_roster_snapshot"();

CREATE TRIGGER "ContactAuditRosterEntry_immutable_delete"
BEFORE DELETE ON "ContactAuditRosterEntry"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_roster_snapshot"();

CREATE OR REPLACE FUNCTION "guard_contact_audit_resolution"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."resolution" IS NOT NULL AND (
    NEW."resolution" IS DISTINCT FROM OLD."resolution"
    OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
    OR NEW."selectedAlternativeId" IS DISTINCT FROM OLD."selectedAlternativeId"
    OR NEW."resolvedContactId" IS DISTINCT FROM OLD."resolvedContactId"
    OR NEW."resolvedArtistId" IS DISTINCT FROM OLD."resolvedArtistId"
    OR NEW."resolvedArtistName" IS DISTINCT FROM OLD."resolvedArtistName"
    OR NEW."resolvedEmail" IS DISTINCT FROM OLD."resolvedEmail"
    OR NEW."resolvedPhone" IS DISTINCT FROM OLD."resolvedPhone"
    OR NEW."resolvedDirectOutreachNote" IS DISTINCT FROM OLD."resolvedDirectOutreachNote"
    OR NEW."resolvedName" IS DISTINCT FROM OLD."resolvedName"
    OR NEW."resolvedRole" IS DISTINCT FROM OLD."resolvedRole"
    OR NEW."resolvedSource" IS DISTINCT FROM OLD."resolvedSource"
    OR NEW."resolvedState" IS DISTINCT FROM OLD."resolvedState"
    OR NEW."resolutionClaimToken" IS DISTINCT FROM OLD."resolutionClaimToken"
    OR NEW."resolutionClaimedAt" IS DISTINCT FROM OLD."resolutionClaimedAt"
    OR NEW."finding" IS DISTINCT FROM OLD."finding"
    OR NEW."sourceUrls" IS DISTINCT FROM OLD."sourceUrls"
    OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
    OR NEW."confidence" IS DISTINCT FROM OLD."confidence"
    OR NEW."agentNotes" IS DISTINCT FROM OLD."agentNotes"
    OR NEW."rosterReview" IS DISTINCT FROM OLD."rosterReview"
    OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
    OR NEW."rosterSnapshotId" IS DISTINCT FROM OLD."rosterSnapshotId"
    OR NEW."targetRosterEntryId" IS DISTINCT FROM OLD."targetRosterEntryId"
    OR NEW."snapshotArtistName" IS DISTINCT FROM OLD."snapshotArtistName"
    OR NEW."snapshotEmail" IS DISTINCT FROM OLD."snapshotEmail"
    OR NEW."snapshotPhone" IS DISTINCT FROM OLD."snapshotPhone"
    OR NEW."snapshotDirectOutreachNote" IS DISTINCT FROM OLD."snapshotDirectOutreachNote"
    OR NEW."snapshotName" IS DISTINCT FROM OLD."snapshotName"
    OR NEW."snapshotRole" IS DISTINCT FROM OLD."snapshotRole"
    OR NEW."snapshotSource" IS DISTINCT FROM OLD."snapshotSource"
    OR NEW."snapshotNotes" IS DISTINCT FROM OLD."snapshotNotes"
  ) THEN
    RAISE EXCEPTION 'Resolved contact audit decisions and provenance are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
