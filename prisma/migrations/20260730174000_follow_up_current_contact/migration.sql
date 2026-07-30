BEGIN;

CREATE OR REPLACE FUNCTION "enforce_outreach_follow_up_identity"()
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
    THEN
      RAISE EXCEPTION 'Follow-up show and artist must match its original outreach';
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
      )
    THEN
      RAISE EXCEPTION 'Original outreach show and artist must match its follow-up';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
