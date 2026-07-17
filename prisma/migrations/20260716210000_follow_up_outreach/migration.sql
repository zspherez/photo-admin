BEGIN;

CREATE TYPE "OutreachKind" AS ENUM ('original', 'follow_up');

ALTER TABLE "Outreach"
  ADD COLUMN "kind" "OutreachKind" NOT NULL DEFAULT 'original',
  ADD COLUMN "parentOutreachId" TEXT;

-- Every existing logical message predates follow-ups and remains an original.
UPDATE "Outreach" SET "kind" = 'original';

DROP INDEX "Outreach_showId_contactId_key";

-- PostgreSQL's null semantics intentionally preserve artist-level/manual rows.
-- Non-null contacts may have one original and one follow-up logical message.
CREATE UNIQUE INDEX "Outreach_showId_contactId_kind_key"
  ON "Outreach"("showId", "contactId", "kind");
CREATE UNIQUE INDEX "Outreach_parentOutreachId_key"
  ON "Outreach"("parentOutreachId");
CREATE INDEX "Outreach_kind_status_scheduledFor_idx"
  ON "Outreach"("kind", "status", "scheduledFor");

ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_follow_up_parent_shape_check"
  CHECK (
    (
      "kind" = 'original'
      AND "parentOutreachId" IS NULL
    )
    OR (
      "kind" = 'follow_up'
      AND "parentOutreachId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "Outreach_parentOutreachId_fkey"
  FOREIGN KEY ("parentOutreachId") REFERENCES "Outreach"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "prevent_outreach_kind_parent_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."parentOutreachId" IS DISTINCT FROM OLD."parentOutreachId"
  THEN
    RAISE EXCEPTION 'Outreach kind and parent identity are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Outreach_kind_parent_immutable"
BEFORE UPDATE ON "Outreach"
FOR EACH ROW
EXECUTE FUNCTION "prevent_outreach_kind_parent_mutation"();

CREATE FUNCTION "enforce_outreach_follow_up_identity"()
RETURNS TRIGGER AS $$
DECLARE
  related "Outreach"%ROWTYPE;
BEGIN
  IF NEW."kind" = 'follow_up' THEN
    SELECT *
    INTO related
    FROM "Outreach"
    WHERE "id" = NEW."parentOutreachId";

    IF NOT FOUND OR related."kind" <> 'original' THEN
      RAISE EXCEPTION 'Follow-up parent must be an original outreach';
    END IF;

    IF related."showId" IS DISTINCT FROM NEW."showId"
      OR related."artistId" IS DISTINCT FROM NEW."artistId"
      OR related."contactId" IS DISTINCT FROM NEW."contactId"
    THEN
      RAISE EXCEPTION 'Follow-up identity must match its original outreach';
    END IF;
  ELSE
    SELECT *
    INTO related
    FROM "Outreach"
    WHERE "parentOutreachId" = NEW."id";

    IF FOUND
      AND (
        related."showId" IS DISTINCT FROM NEW."showId"
        OR related."artistId" IS DISTINCT FROM NEW."artistId"
        OR related."contactId" IS DISTINCT FROM NEW."contactId"
      )
    THEN
      RAISE EXCEPTION 'Original outreach identity must match its follow-up';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferral keeps Contact ON DELETE SET NULL safe when an original and its
-- follow-up are updated by the same referential action.
CREATE CONSTRAINT TRIGGER "Outreach_follow_up_identity"
AFTER INSERT OR UPDATE ON "Outreach"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_outreach_follow_up_identity"();

COMMIT;
