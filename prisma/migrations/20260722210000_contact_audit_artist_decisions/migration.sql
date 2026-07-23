BEGIN;

CREATE TABLE "ContactAuditArtistDecision" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "snapshotArtistName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "selectedAlternativeId" TEXT,
  "createdContactId" TEXT,
  "resolvedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactAuditArtistDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditArtistDecision_artistName_check"
    CHECK (char_length(btrim("snapshotArtistName")) > 0),
  CONSTRAINT "ContactAuditArtistDecision_action_check"
    CHECK (
      "action" IN (
        'append',
        'replace_selected',
        'deactivate_selected',
        'rejected'
      )
    ),
  CONSTRAINT "ContactAuditArtistDecision_action_consistency_check"
    CHECK (
      (
        "action" IN ('append', 'replace_selected')
        AND "selectedAlternativeId" IS NOT NULL
        AND "createdContactId" IS NOT NULL
      )
      OR
      (
        "action" IN ('deactivate_selected', 'rejected')
        AND "selectedAlternativeId" IS NULL
        AND "createdContactId" IS NULL
      )
    )
);

CREATE TABLE "ContactAuditDecisionContact" (
  "decisionId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "snapshotEmail" TEXT,
  "snapshotPhone" TEXT,
  "snapshotDirectOutreachNote" TEXT,
  "snapshotName" TEXT,
  "snapshotRole" TEXT,
  "snapshotSource" TEXT,
  "snapshotNotes" TEXT,
  "snapshotIsFullTeam" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactAuditDecisionContact_pkey"
    PRIMARY KEY ("decisionId", "contactId"),
  CONSTRAINT "ContactAuditDecisionContact_action_check"
    CHECK ("action" = 'quarantined')
);

CREATE UNIQUE INDEX "ContactAuditArtistDecision_runId_artistId_key"
  ON "ContactAuditArtistDecision"("runId", "artistId");
CREATE INDEX "ContactAuditArtistDecision_artistId_resolvedAt_idx"
  ON "ContactAuditArtistDecision"("artistId", "resolvedAt");
CREATE INDEX "ContactAuditArtistDecision_selectedAlternativeId_idx"
  ON "ContactAuditArtistDecision"("selectedAlternativeId");
CREATE INDEX "ContactAuditArtistDecision_createdContactId_idx"
  ON "ContactAuditArtistDecision"("createdContactId");
CREATE INDEX "ContactAuditDecisionContact_contactId_idx"
  ON "ContactAuditDecisionContact"("contactId");

ALTER TABLE "ContactAuditArtistDecision"
  ADD CONSTRAINT "ContactAuditArtistDecision_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ContactAuditRun"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactAuditArtistDecision_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactAuditArtistDecision_selectedAlternativeId_fkey"
  FOREIGN KEY ("selectedAlternativeId") REFERENCES "ContactAuditAlternative"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactAuditArtistDecision_createdContactId_fkey"
  FOREIGN KEY ("createdContactId") REFERENCES "Contact"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContactAuditDecisionContact"
  ADD CONSTRAINT "ContactAuditDecisionContact_decisionId_fkey"
  FOREIGN KEY ("decisionId") REFERENCES "ContactAuditArtistDecision"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "ContactAuditDecisionContact_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "validate_contact_audit_artist_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ContactAuditJob" job
    WHERE job."runId" = NEW."runId"
      AND job."artistId" = NEW."artistId"
      AND (
        job."status" <> 'complete'
        OR job."resolution" IS NOT NULL
        OR job."resolutionClaimToken" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Artist contact audit decisions require complete unclaimed jobs';
  END IF;

  IF NEW."selectedAlternativeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "ContactAuditAlternative" alternative
    JOIN "ContactAuditJob" job ON job."id" = alternative."jobId"
    WHERE alternative."id" = NEW."selectedAlternativeId"
      AND job."runId" = NEW."runId"
      AND job."artistId" = NEW."artistId"
  ) THEN
    RAISE EXCEPTION 'Selected contact audit alternative must belong to the artist audit';
  END IF;

  IF NEW."createdContactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "Contact" contact
    WHERE contact."id" = NEW."createdContactId"
      AND contact."artistId" = NEW."artistId"
  ) THEN
    RAISE EXCEPTION 'Created contact audit contact must belong to the audited artist';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditArtistDecision_validate"
BEFORE INSERT OR UPDATE ON "ContactAuditArtistDecision"
FOR EACH ROW
EXECUTE FUNCTION "validate_contact_audit_artist_decision"();

CREATE FUNCTION "guard_contact_audit_job_after_artist_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."resolution" IS NOT NULL
     AND OLD."resolution" IS NULL
     AND NEW."artistId" IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM "ContactAuditArtistDecision" decision
       WHERE decision."runId" = NEW."runId"
         AND decision."artistId" = NEW."artistId"
     ) THEN
    RAISE EXCEPTION 'Artist-level contact audit decision already exists';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditJob_guard_artist_decision"
BEFORE UPDATE ON "ContactAuditJob"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_job_after_artist_decision"();

CREATE FUNCTION "seal_contact_audit_decision_contacts"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ContactAuditArtistDecision"
    WHERE "id" = NEW."decisionId"
  ) THEN
    RAISE EXCEPTION 'Contact audit decision contacts are sealed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditDecisionContact_seal_insert"
BEFORE INSERT ON "ContactAuditDecisionContact"
FOR EACH ROW
EXECUTE FUNCTION "seal_contact_audit_decision_contacts"();

CREATE FUNCTION "validate_contact_audit_decision_contact"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ContactAuditArtistDecision" decision
    JOIN "Contact" contact
      ON contact."id" = NEW."contactId"
     AND contact."artistId" = decision."artistId"
    JOIN "ContactAuditRosterSnapshot" snapshot
      ON snapshot."runId" = decision."runId"
     AND snapshot."snapshotArtistId" = decision."artistId"
    JOIN "ContactAuditRosterEntry" entry
      ON entry."rosterSnapshotId" = snapshot."id"
     AND entry."snapshotContactId" = NEW."contactId"
    WHERE decision."id" = NEW."decisionId"
  ) THEN
    RAISE EXCEPTION 'Contact audit decision contact must belong to the immutable artist roster';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ContactAuditDecisionContact_validate"
AFTER INSERT ON "ContactAuditDecisionContact"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_contact_audit_decision_contact"();

CREATE FUNCTION "validate_contact_audit_decision_contact_count"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  mutation_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER
  INTO mutation_count
  FROM "ContactAuditDecisionContact"
  WHERE "decisionId" = NEW."id";

  IF NEW."action" IN ('replace_selected', 'deactivate_selected')
     AND mutation_count = 0 THEN
    RAISE EXCEPTION 'Selected contact audit action requires at least one contact';
  END IF;
  IF NEW."action" IN ('append', 'rejected')
     AND mutation_count <> 0 THEN
    RAISE EXCEPTION 'This contact audit action cannot quarantine contacts';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ContactAuditArtistDecision_validate_contact_count"
AFTER INSERT ON "ContactAuditArtistDecision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_contact_audit_decision_contact_count"();

CREATE FUNCTION "guard_contact_audit_artist_decision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Contact audit artist decisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ContactAuditArtistDecision_immutable_update"
BEFORE UPDATE ON "ContactAuditArtistDecision"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_artist_decision"();

CREATE TRIGGER "ContactAuditArtistDecision_immutable_delete"
BEFORE DELETE ON "ContactAuditArtistDecision"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_artist_decision"();

CREATE TRIGGER "ContactAuditDecisionContact_immutable_update"
BEFORE UPDATE ON "ContactAuditDecisionContact"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_artist_decision"();

CREATE TRIGGER "ContactAuditDecisionContact_immutable_delete"
BEFORE DELETE ON "ContactAuditDecisionContact"
FOR EACH ROW
EXECUTE FUNCTION "guard_contact_audit_artist_decision"();

COMMIT;
