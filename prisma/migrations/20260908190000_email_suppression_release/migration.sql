BEGIN;

CREATE TABLE "EmailSuppressionRelease" (
  "id" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceEventId" TEXT,
  "suppressedAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSuppressionRelease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailSuppressionRelease_note_check"
    CHECK (length(trim("note")) BETWEEN 1 AND 1000)
);

CREATE INDEX "EmailSuppressionRelease_normalizedEmail_createdAt_idx"
  ON "EmailSuppressionRelease"("normalizedEmail", "createdAt");

COMMIT;
