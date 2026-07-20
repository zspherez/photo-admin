BEGIN;

ALTER TABLE "ContactAuditJob"
  ADD COLUMN "snapshotDirectOutreachNote" TEXT,
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "selectedAlternativeId" TEXT,
  ADD COLUMN "resolvedContactId" TEXT,
  ADD COLUMN "resolvedArtistId" TEXT,
  ADD COLUMN "resolvedArtistName" TEXT,
  ADD COLUMN "resolvedEmail" TEXT,
  ADD COLUMN "resolvedPhone" TEXT,
  ADD COLUMN "resolvedDirectOutreachNote" TEXT,
  ADD COLUMN "resolvedName" TEXT,
  ADD COLUMN "resolvedRole" TEXT,
  ADD COLUMN "resolvedSource" TEXT,
  ADD COLUMN "resolvedState" TEXT,
  ADD COLUMN "resolutionClaimToken" TEXT,
  ADD COLUMN "resolutionClaimedAt" TIMESTAMP(3);

UPDATE "ContactAuditJob" job
SET "snapshotDirectOutreachNote" = contact."directOutreachNote"
FROM "Contact" contact
WHERE contact."id" = job."contactId";

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('approved', 'rejected')),
  ADD CONSTRAINT "ContactAuditJob_resolvedState_check"
    CHECK (
      "resolvedState" IS NULL OR
      "resolvedState" IN ('active', 'quarantined')
    ),
  ADD CONSTRAINT "ContactAuditJob_resolution_claim_check"
    CHECK (
      (
        "resolutionClaimToken" IS NULL
        AND "resolutionClaimedAt" IS NULL
      )
      OR
      (
        "resolution" IS NULL
        AND "resolutionClaimToken" IS NOT NULL
        AND "resolutionClaimedAt" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "ContactAuditJob_resolution_consistency_check"
    CHECK (
      (
        "resolution" IS NULL
        AND "resolvedAt" IS NULL
        AND "selectedAlternativeId" IS NULL
        AND "resolvedContactId" IS NULL
        AND "resolvedArtistId" IS NULL
        AND "resolvedArtistName" IS NULL
        AND "resolvedEmail" IS NULL
        AND "resolvedPhone" IS NULL
        AND "resolvedDirectOutreachNote" IS NULL
        AND "resolvedName" IS NULL
        AND "resolvedRole" IS NULL
        AND "resolvedSource" IS NULL
        AND "resolvedState" IS NULL
      )
      OR
      (
        "resolution" IS NOT NULL
        AND "status" = 'complete'
        AND "finding" IN ('changed', 'stale', 'ambiguous')
        AND "resolvedAt" IS NOT NULL
        AND "resolvedAt" >= "verifiedAt"
        AND "resolvedContactId" IS NOT NULL
        AND "resolvedArtistId" IS NOT NULL
        AND char_length(btrim("resolvedArtistName")) > 0
        AND "resolvedState" IS NOT NULL
        AND "resolutionClaimToken" IS NULL
        AND "resolutionClaimedAt" IS NULL
        AND (
          (
            "resolution" = 'rejected'
            AND "selectedAlternativeId" IS NULL
            AND "resolvedState" = 'active'
          )
          OR
          (
            "resolution" = 'approved'
            AND "finding" IN ('changed', 'ambiguous')
            AND "selectedAlternativeId" IS NOT NULL
            AND "resolvedEmail" IS NOT NULL
            AND "resolvedState" = 'active'
          )
          OR
          (
            "resolution" = 'approved'
            AND "finding" = 'stale'
            AND "selectedAlternativeId" IS NULL
            AND "resolvedState" = 'quarantined'
          )
        )
      )
    );

CREATE UNIQUE INDEX "ContactAuditJob_resolutionClaimToken_key"
  ON "ContactAuditJob"("resolutionClaimToken");
CREATE INDEX "ContactAuditJob_runId_resolution_finding_verifiedAt_idx"
  ON "ContactAuditJob"("runId", "resolution", "finding", "verifiedAt");

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_selectedAlternativeId_fkey"
  FOREIGN KEY ("selectedAlternativeId") REFERENCES "ContactAuditAlternative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "guard_contact_audit_resolution"()
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
    OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
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

CREATE TRIGGER "ContactAuditJob_immutable_resolution"
BEFORE UPDATE ON "ContactAuditJob"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_resolution"();

CREATE FUNCTION "guard_resolved_contact_audit_delete"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."resolution" IS NOT NULL THEN
    RAISE EXCEPTION 'Resolved contact audit history cannot be deleted';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactAuditJob_preserve_resolved_history"
BEFORE DELETE ON "ContactAuditJob"
FOR EACH ROW
EXECUTE FUNCTION "guard_resolved_contact_audit_delete"();

CREATE FUNCTION "guard_selected_contact_audit_alternative"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ContactAuditJob"
    WHERE "id" = OLD."jobId"
      AND "resolution" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Resolved contact audit alternatives are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactAuditAlternative_preserve_selected_update"
BEFORE UPDATE ON "ContactAuditAlternative"
FOR EACH ROW
EXECUTE FUNCTION "guard_selected_contact_audit_alternative"();

CREATE TRIGGER "ContactAuditAlternative_preserve_selected_delete"
BEFORE DELETE ON "ContactAuditAlternative"
FOR EACH ROW
EXECUTE FUNCTION "guard_selected_contact_audit_alternative"();

CREATE FUNCTION "validate_contact_audit_selected_alternative"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."selectedAlternativeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ContactAuditAlternative"
    WHERE "id" = NEW."selectedAlternativeId"
      AND "jobId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Selected contact audit alternative must belong to its job';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContactAuditJob_validate_selected_alternative"
BEFORE INSERT OR UPDATE ON "ContactAuditJob"
FOR EACH ROW
EXECUTE FUNCTION "validate_contact_audit_selected_alternative"();

COMMIT;
