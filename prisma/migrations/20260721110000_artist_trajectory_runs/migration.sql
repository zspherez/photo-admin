BEGIN;

CREATE TYPE "TrajectoryRunStatus" AS ENUM (
  'importing',
  'ready',
  'stale',
  'superseded',
  'failed'
);

CREATE TYPE "TrajectoryArm" AS ENUM (
  'trajectory',
  'momentum',
  'exploration',
  'portfolio'
);

CREATE TYPE "TrajectoryCoverageState" AS ENUM (
  'C_covered',
  'U0_unresolved',
  'U1_no_history',
  'U2_thin_history',
  'Q_query_incomplete',
  'Q_query_failure',
  'J_junk'
);

CREATE TYPE "TrajectoryImportIssueCode" AS ENUM (
  'show_not_found',
  'artist_not_found',
  'show_artist_membership_missing'
);

CREATE TABLE "TrajectoryModelRun" (
  "id" TEXT NOT NULL,
  "producer" TEXT NOT NULL,
  "producerRunId" TEXT NOT NULL,
  "contractVersion" TEXT NOT NULL,
  "producerSchemaVersion" TEXT NOT NULL,
  "artifactSha256" TEXT NOT NULL,
  "fullArtifactSha256" TEXT NOT NULL,
  "artifactGzip" BYTEA,
  "artifactByteLength" INTEGER NOT NULL,
  "producerRevision" TEXT,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  "asOfDate" DATE NOT NULL,
  "decisionDate" DATE NOT NULL,
  "minimumShowDate" DATE NOT NULL,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "modelStatus" TEXT NOT NULL,
  "validationReference" TEXT,
  "status" "TrajectoryRunStatus" NOT NULL,
  "summary" JSONB,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrajectoryModelRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrajectoryModelRun_producer_check"
    CHECK ("producer" = 'artist_trajectory'),
  CONSTRAINT "TrajectoryModelRun_contractVersion_check"
    CHECK ("contractVersion" = 'photo-admin-import-v1'),
  CONSTRAINT "TrajectoryModelRun_artifactSha256_check"
    CHECK (
      char_length("artifactSha256") = 64
      AND "artifactSha256" ~ '^[0-9a-f]+$'
    ),
  CONSTRAINT "TrajectoryModelRun_fullArtifactSha256_check"
    CHECK (
      char_length("fullArtifactSha256") = 64
      AND "fullArtifactSha256" ~ '^[0-9a-f]+$'
    ),
  CONSTRAINT "TrajectoryModelRun_artifactByteLength_check"
    CHECK ("artifactByteLength" >= 1 AND "artifactByteLength" <= 1000000),
  CONSTRAINT "TrajectoryModelRun_dates_check"
    CHECK (
      "asOfDate" <= "decisionDate"
      AND "decisionDate" <= "minimumShowDate"
      AND "generatedAt" >= "decisionDate"::timestamp
      AND "generatedAt" < "validUntil"
    ),
  CONSTRAINT "TrajectoryModelRun_freshness_check"
    CHECK ("validUntil" = "generatedAt" + INTERVAL '72 hours'),
  CONSTRAINT "TrajectoryModelRun_modelStatus_check"
    CHECK (char_length(btrim("modelStatus")) > 0),
  CONSTRAINT "TrajectoryModelRun_activation_check"
    CHECK (
      (
        "status" IN ('importing', 'failed')
        AND "activatedAt" IS NULL
      )
      OR
      (
        "status" IN ('ready', 'stale', 'superseded')
        AND "activatedAt" IS NOT NULL
      )
    ),
  CONSTRAINT "TrajectoryModelRun_failure_check"
    CHECK (
      (
        "status" = 'failed'
        AND "failureCode" IS NOT NULL
        AND "failureMessage" IS NOT NULL
      )
      OR
      (
        "status" <> 'failed'
        AND "failureCode" IS NULL
        AND "failureMessage" IS NULL
      )
    )
);

CREATE TABLE "TrajectoryRunArtist" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "artistId" TEXT,
  "edmtrainArtistId" INTEGER NOT NULL,
  "sourceName" TEXT NOT NULL,
  "spotifyArtistId" TEXT,
  "raArtistId" TEXT,
  "coverageState" "TrajectoryCoverageState" NOT NULL,
  "momentumBand" TEXT,
  "isEarlyStage" BOOLEAN NOT NULL,
  "isEstablished" BOOLEAN NOT NULL,
  "isVeteran" BOOLEAN NOT NULL,
  "eventDelta6m" INTEGER,
  "eventsPrior6m" INTEGER,
  "eventsRecent6m" INTEGER,
  "marketsPrior6m" INTEGER,
  "marketsRecent6m" INTEGER,
  "careerAgeYears" DOUBLE PRECISION,
  "analogSummary" JSONB,
  "releaseContext" JSONB,
  "genres" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrajectoryRunArtist_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrajectoryRunArtist_edmtrainArtistId_check"
    CHECK ("edmtrainArtistId" > 0),
  CONSTRAINT "TrajectoryRunArtist_sourceName_check"
    CHECK (char_length(btrim("sourceName")) > 0),
  CONSTRAINT "TrajectoryRunArtist_momentumBand_check"
    CHECK (
      (
        "coverageState" = 'C_covered'
        AND "momentumBand" IN (
          'rising',
          'strong_acceleration',
          'declining',
          'flat'
        )
      )
      OR
      (
        "coverageState" <> 'C_covered'
        AND "momentumBand" IS NULL
      )
    ),
  CONSTRAINT "TrajectoryRunArtist_featureCounts_check"
    CHECK (
      ("eventsPrior6m" IS NULL OR "eventsPrior6m" >= 0)
      AND ("eventsRecent6m" IS NULL OR "eventsRecent6m" >= 0)
      AND ("marketsPrior6m" IS NULL OR "marketsPrior6m" >= 0)
      AND ("marketsRecent6m" IS NULL OR "marketsRecent6m" >= 0)
      AND (
        "careerAgeYears" IS NULL
        OR (
          "careerAgeYears" >= 0
          AND "careerAgeYears" <> 'NaN'::double precision
        )
      )
    )
);

CREATE TABLE "TrajectoryRecommendation" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "showId" TEXT NOT NULL,
  "runArtistId" TEXT NOT NULL,
  "arm" "TrajectoryArm" NOT NULL,
  "listRank" INTEGER NOT NULL,
  "isSuggested" BOOLEAN NOT NULL DEFAULT false,
  "slatePosition" INTEGER,
  "billingPosition" INTEGER NOT NULL,
  "lineupSize" INTEGER NOT NULL,
  "isFirstBilled" BOOLEAN NOT NULL,
  "rationale" JSONB,
  "sourceFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrajectoryRecommendation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrajectoryRecommendation_rank_check"
    CHECK ("listRank" > 0),
  CONSTRAINT "TrajectoryRecommendation_slate_check"
    CHECK (
      (
        "isSuggested"
        AND "slatePosition" IS NOT NULL
        AND "slatePosition" > 0
      )
      OR
      (
        NOT "isSuggested"
        AND "slatePosition" IS NULL
      )
    ),
  CONSTRAINT "TrajectoryRecommendation_billing_check"
    CHECK (
      "billingPosition" > 0
      AND "lineupSize" > 0
      AND "billingPosition" <= "lineupSize"
      AND "isFirstBilled" = ("billingPosition" = 1)
    ),
  CONSTRAINT "TrajectoryRecommendation_sourceFingerprint_check"
    CHECK (
      char_length("sourceFingerprint") = 64
      AND "sourceFingerprint" ~ '^[0-9a-f]+$'
    )
);

CREATE TABLE "TrajectoryImportIssue" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "recommendationKey" TEXT,
  "code" "TrajectoryImportIssueCode" NOT NULL,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TrajectoryImportIssue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrajectoryModelRun_producer_producerRunId_key"
  ON "TrajectoryModelRun"("producer", "producerRunId");
CREATE UNIQUE INDEX "TrajectoryModelRun_producer_artifactSha256_key"
  ON "TrajectoryModelRun"("producer", "artifactSha256");
CREATE UNIQUE INDEX "TrajectoryModelRun_one_ready_artist_trajectory_idx"
  ON "TrajectoryModelRun"("producer")
  WHERE "producer" = 'artist_trajectory' AND "status" = 'ready';
CREATE INDEX "TrajectoryModelRun_status_generatedAt_idx"
  ON "TrajectoryModelRun"("status", "generatedAt");
CREATE INDEX "TrajectoryModelRun_validUntil_idx"
  ON "TrajectoryModelRun"("validUntil");

CREATE UNIQUE INDEX "TrajectoryRunArtist_runId_edmtrainArtistId_key"
  ON "TrajectoryRunArtist"("runId", "edmtrainArtistId");
CREATE INDEX "TrajectoryRunArtist_runId_coverageState_idx"
  ON "TrajectoryRunArtist"("runId", "coverageState");
CREATE INDEX "TrajectoryRunArtist_artistId_idx"
  ON "TrajectoryRunArtist"("artistId");

CREATE UNIQUE INDEX "TrajectoryRecommendation_runId_showId_runArtistId_arm_key"
  ON "TrajectoryRecommendation"("runId", "showId", "runArtistId", "arm");
CREATE UNIQUE INDEX "TrajectoryRecommendation_runId_arm_listRank_key"
  ON "TrajectoryRecommendation"("runId", "arm", "listRank");
CREATE UNIQUE INDEX "TrajectoryRecommendation_runId_slatePosition_suggested_key"
  ON "TrajectoryRecommendation"("runId", "slatePosition")
  WHERE "isSuggested";
CREATE INDEX "TrajectoryRecommendation_runId_arm_listRank_idx"
  ON "TrajectoryRecommendation"("runId", "arm", "listRank");
CREATE INDEX "TrajectoryRecommendation_runId_isSuggested_slatePosition_idx"
  ON "TrajectoryRecommendation"("runId", "isSuggested", "slatePosition");
CREATE INDEX "TrajectoryRecommendation_showId_idx"
  ON "TrajectoryRecommendation"("showId");

CREATE INDEX "TrajectoryImportIssue_runId_code_idx"
  ON "TrajectoryImportIssue"("runId", "code");

ALTER TABLE "TrajectoryRunArtist"
  ADD CONSTRAINT "TrajectoryRunArtist_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "TrajectoryModelRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrajectoryRunArtist"
  ADD CONSTRAINT "TrajectoryRunArtist_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TrajectoryRecommendation"
  ADD CONSTRAINT "TrajectoryRecommendation_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "TrajectoryModelRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrajectoryRecommendation"
  ADD CONSTRAINT "TrajectoryRecommendation_showId_fkey"
  FOREIGN KEY ("showId") REFERENCES "Show"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrajectoryRecommendation"
  ADD CONSTRAINT "TrajectoryRecommendation_runArtistId_fkey"
  FOREIGN KEY ("runArtistId") REFERENCES "TrajectoryRunArtist"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrajectoryImportIssue"
  ADD CONSTRAINT "TrajectoryImportIssue_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "TrajectoryModelRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
