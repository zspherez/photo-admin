BEGIN;

CREATE TABLE "TrajectoryIngestRequest" (
  "idempotencyKey" TEXT NOT NULL,
  "ownerToken" TEXT NOT NULL,
  "producerRunId" TEXT NOT NULL,
  "artifactSha256" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "producedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "response" JSONB,
  "httpStatus" INTEGER,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrajectoryIngestRequest_pkey" PRIMARY KEY ("idempotencyKey"),
  CONSTRAINT "TrajectoryIngestRequest_idempotencyKey_check"
    CHECK (
      char_length("idempotencyKey") BETWEEN 8 AND 128
      AND "idempotencyKey" ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT "TrajectoryIngestRequest_ownerToken_check"
    CHECK (char_length("ownerToken") = 36),
  CONSTRAINT "TrajectoryIngestRequest_producerRunId_check"
    CHECK (
      "producerRunId" ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "TrajectoryIngestRequest_artifactSha256_check"
    CHECK (
      char_length("artifactSha256") = 64
      AND "artifactSha256" ~ '^[0-9a-f]+$'
    ),
  CONSTRAINT "TrajectoryIngestRequest_mode_check"
    CHECK ("mode" = 'apply'),
  CONSTRAINT "TrajectoryIngestRequest_status_check"
    CHECK ("status" IN ('processing', 'completed')),
  CONSTRAINT "TrajectoryIngestRequest_completion_check"
    CHECK (
      (
        "status" = 'processing'
        AND "response" IS NULL
        AND "httpStatus" IS NULL
        AND "completedAt" IS NULL
      )
      OR
      (
        "status" = 'completed'
        AND "response" IS NOT NULL
        AND "httpStatus" BETWEEN 200 AND 299
        AND "completedAt" IS NOT NULL
      )
    )
);

CREATE INDEX "TrajectoryIngestRequest_producerRunId_artifactSha256_mode_status_idx"
  ON "TrajectoryIngestRequest"(
    "producerRunId",
    "artifactSha256",
    "mode",
    "status"
  );

COMMIT;
