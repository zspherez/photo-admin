BEGIN;

CREATE TYPE "TrajectoryFeedbackAction" AS ENUM (
  'selected',
  'declined',
  'saved',
  'dismissed',
  'manual_override'
);

CREATE TYPE "TrajectoryAccessOutcome" AS ENUM (
  'none',
  'guestlist',
  'photo_pass',
  'other'
);

CREATE TYPE "TrajectoryShootability" AS ENUM (
  'good',
  'ok',
  'poor'
);

CREATE TYPE "TrajectoryVenueAccessibility" AS ENUM (
  'high',
  'medium',
  'low'
);

ALTER TABLE "Outreach"
  ADD COLUMN "trajectoryRecommendationId" TEXT;

CREATE TABLE "TrajectoryFeedbackEvent" (
  "id" TEXT NOT NULL,
  "recommendationId" TEXT NOT NULL,
  "action" "TrajectoryFeedbackAction" NOT NULL,
  "propensity" DOUBLE PRECISION,
  "manualOverride" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "supersedesId" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrajectoryFeedbackEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrajectoryFeedbackEvent_propensity_check"
    CHECK (
      "propensity" IS NULL
      OR (
        "propensity" >= 0
        AND "propensity" <= 1
        AND "propensity" <> 'NaN'::double precision
      )
    ),
  CONSTRAINT "TrajectoryFeedbackEvent_manualOverride_check"
    CHECK (
      ("action" = 'manual_override') = "manualOverride"
    ),
  CONSTRAINT "TrajectoryFeedbackEvent_idempotencyKey_check"
    CHECK (
      char_length(btrim("idempotencyKey")) BETWEEN 1 AND 200
    ),
  CONSTRAINT "TrajectoryFeedbackEvent_notes_check"
    CHECK (
      "notes" IS NULL
      OR char_length("notes") <= 4000
    ),
  CONSTRAINT "TrajectoryFeedbackEvent_supersedes_self_check"
    CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id")
);

CREATE TABLE "TrajectoryShowOutcome" (
  "id" TEXT NOT NULL,
  "recommendationId" TEXT NOT NULL,
  "attended" BOOLEAN,
  "access" "TrajectoryAccessOutcome",
  "keeperCount" INTEGER,
  "relationshipValue" INTEGER,
  "publicationValue" INTEGER,
  "shootability" "TrajectoryShootability",
  "venueAccessibility" "TrajectoryVenueAccessibility",
  "notes" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "supersedesId" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrajectoryShowOutcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrajectoryShowOutcome_keeperCount_check"
    CHECK ("keeperCount" IS NULL OR "keeperCount" >= 0),
  CONSTRAINT "TrajectoryShowOutcome_relationshipValue_check"
    CHECK (
      "relationshipValue" IS NULL
      OR "relationshipValue" BETWEEN 0 AND 2
    ),
  CONSTRAINT "TrajectoryShowOutcome_publicationValue_check"
    CHECK (
      "publicationValue" IS NULL
      OR "publicationValue" BETWEEN 0 AND 2
    ),
  CONSTRAINT "TrajectoryShowOutcome_attendance_check"
    CHECK (
      "keeperCount" IS NULL
      OR "keeperCount" = 0
      OR "attended" = true
    ),
  CONSTRAINT "TrajectoryShowOutcome_evidence_check"
    CHECK (
      "attended" IS NOT NULL
      OR "access" IS NOT NULL
      OR "keeperCount" IS NOT NULL
      OR "relationshipValue" IS NOT NULL
      OR "publicationValue" IS NOT NULL
      OR "shootability" IS NOT NULL
      OR "venueAccessibility" IS NOT NULL
    ),
  CONSTRAINT "TrajectoryShowOutcome_idempotencyKey_check"
    CHECK (
      char_length(btrim("idempotencyKey")) BETWEEN 1 AND 200
    ),
  CONSTRAINT "TrajectoryShowOutcome_notes_check"
    CHECK (
      "notes" IS NULL
      OR char_length("notes") <= 4000
    ),
  CONSTRAINT "TrajectoryShowOutcome_supersedes_self_check"
    CHECK ("supersedesId" IS NULL OR "supersedesId" <> "id")
);

CREATE UNIQUE INDEX "TrajectoryFeedbackEvent_idempotencyKey_key"
  ON "TrajectoryFeedbackEvent"("idempotencyKey");
CREATE UNIQUE INDEX "TrajectoryFeedbackEvent_supersedesId_key"
  ON "TrajectoryFeedbackEvent"("supersedesId");
CREATE INDEX "TrajectoryFeedbackEvent_recommendationId_recordedAt_idx"
  ON "TrajectoryFeedbackEvent"("recommendationId", "recordedAt");
CREATE INDEX "TrajectoryFeedbackEvent_action_recordedAt_idx"
  ON "TrajectoryFeedbackEvent"("action", "recordedAt");

CREATE UNIQUE INDEX "TrajectoryShowOutcome_idempotencyKey_key"
  ON "TrajectoryShowOutcome"("idempotencyKey");
CREATE UNIQUE INDEX "TrajectoryShowOutcome_supersedesId_key"
  ON "TrajectoryShowOutcome"("supersedesId");
CREATE INDEX "TrajectoryShowOutcome_recommendationId_recordedAt_idx"
  ON "TrajectoryShowOutcome"("recommendationId", "recordedAt");
CREATE INDEX "TrajectoryShowOutcome_recordedAt_idx"
  ON "TrajectoryShowOutcome"("recordedAt");

CREATE INDEX "Outreach_trajectoryRecommendationId_idx"
  ON "Outreach"("trajectoryRecommendationId");

ALTER TABLE "TrajectoryFeedbackEvent"
  ADD CONSTRAINT "TrajectoryFeedbackEvent_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "TrajectoryRecommendation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrajectoryFeedbackEvent"
  ADD CONSTRAINT "TrajectoryFeedbackEvent_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "TrajectoryFeedbackEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrajectoryShowOutcome"
  ADD CONSTRAINT "TrajectoryShowOutcome_recommendationId_fkey"
  FOREIGN KEY ("recommendationId") REFERENCES "TrajectoryRecommendation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrajectoryShowOutcome"
  ADD CONSTRAINT "TrajectoryShowOutcome_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "TrajectoryShowOutcome"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_trajectoryRecommendationId_fkey"
  FOREIGN KEY ("trajectoryRecommendationId") REFERENCES "TrajectoryRecommendation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "validate_trajectory_feedback_supersession"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_row "TrajectoryFeedbackEvent"%ROWTYPE;
BEGIN
  IF NEW."supersedesId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO prior_row
  FROM "TrajectoryFeedbackEvent"
  WHERE "id" = NEW."supersedesId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Superseded trajectory feedback event does not exist';
  END IF;
  IF prior_row."recommendationId" <> NEW."recommendationId" THEN
    RAISE EXCEPTION 'Trajectory feedback corrections must preserve recommendation attribution';
  END IF;
  IF NEW."recordedAt" < prior_row."recordedAt" THEN
    RAISE EXCEPTION 'Trajectory feedback corrections cannot predate prior evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TrajectoryFeedbackEvent_validate_supersession"
BEFORE INSERT ON "TrajectoryFeedbackEvent"
FOR EACH ROW
EXECUTE FUNCTION "validate_trajectory_feedback_supersession"();

CREATE FUNCTION "validate_trajectory_outcome_supersession"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_row "TrajectoryShowOutcome"%ROWTYPE;
BEGIN
  IF NEW."supersedesId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO prior_row
  FROM "TrajectoryShowOutcome"
  WHERE "id" = NEW."supersedesId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Superseded trajectory outcome does not exist';
  END IF;
  IF prior_row."recommendationId" <> NEW."recommendationId" THEN
    RAISE EXCEPTION 'Trajectory outcome corrections must preserve recommendation attribution';
  END IF;
  IF NEW."recordedAt" < prior_row."recordedAt" THEN
    RAISE EXCEPTION 'Trajectory outcome corrections cannot predate prior evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TrajectoryShowOutcome_validate_supersession"
BEFORE INSERT ON "TrajectoryShowOutcome"
FOR EACH ROW
EXECUTE FUNCTION "validate_trajectory_outcome_supersession"();

CREATE FUNCTION "reject_trajectory_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only; append a superseding row instead', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "TrajectoryFeedbackEvent_append_only"
BEFORE UPDATE OR DELETE ON "TrajectoryFeedbackEvent"
FOR EACH ROW
EXECUTE FUNCTION "reject_trajectory_evidence_mutation"();

CREATE TRIGGER "TrajectoryShowOutcome_append_only"
BEFORE UPDATE OR DELETE ON "TrajectoryShowOutcome"
FOR EACH ROW
EXECUTE FUNCTION "reject_trajectory_evidence_mutation"();

CREATE FUNCTION "validate_outreach_trajectory_attribution"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  recommendation_show_id TEXT;
  recommendation_artist_id TEXT;
  parent_recommendation_id TEXT;
BEGIN
  IF (
    TG_OP = 'UPDATE'
    AND OLD."trajectoryRecommendationId" IS NOT NULL
    AND NEW."trajectoryRecommendationId" IS DISTINCT FROM OLD."trajectoryRecommendationId"
  ) THEN
    RAISE EXCEPTION 'Outreach trajectory attribution is immutable once assigned';
  END IF;

  IF NEW."trajectoryRecommendationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT recommendation."showId", run_artist."artistId"
  INTO recommendation_show_id, recommendation_artist_id
  FROM "TrajectoryRecommendation" AS recommendation
  JOIN "TrajectoryRunArtist" AS run_artist
    ON run_artist."id" = recommendation."runArtistId"
  WHERE recommendation."id" = NEW."trajectoryRecommendationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trajectory recommendation does not exist';
  END IF;
  IF recommendation_artist_id IS NULL THEN
    RAISE EXCEPTION 'Trajectory recommendation has no canonical artist attribution';
  END IF;
  IF recommendation_show_id <> NEW."showId" OR recommendation_artist_id <> NEW."artistId" THEN
    RAISE EXCEPTION 'Outreach and trajectory recommendation attribution do not match';
  END IF;
  IF NEW."parentOutreachId" IS NOT NULL THEN
    SELECT parent."trajectoryRecommendationId"
    INTO parent_recommendation_id
    FROM "Outreach" AS parent
    WHERE parent."id" = NEW."parentOutreachId";

    IF parent_recommendation_id IS DISTINCT FROM NEW."trajectoryRecommendationId" THEN
      RAISE EXCEPTION 'Follow-up outreach trajectory attribution must match its parent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Outreach_validate_trajectory_attribution"
BEFORE INSERT OR UPDATE OF
  "trajectoryRecommendationId",
  "showId",
  "artistId"
ON "Outreach"
FOR EACH ROW
EXECUTE FUNCTION "validate_outreach_trajectory_attribution"();

COMMIT;
