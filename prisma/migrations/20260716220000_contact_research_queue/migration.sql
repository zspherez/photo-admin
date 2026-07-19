BEGIN;

CREATE TABLE "ContactResearchJob" (
  "id" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "requestedShowId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "nextShowAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "agentNotes" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactResearchJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactResearchJob_status_check"
    CHECK ("status" IN (
      'pending',
      'claimed',
      'review',
      'complete',
      'exhausted',
      'inactive'
    ))
);

CREATE TABLE "ContactResearchCandidate" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "role" TEXT NOT NULL,
  "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidence" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactResearchCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactResearchCandidate_role_check"
    CHECK ("role" = 'management'),
  CONSTRAINT "ContactResearchCandidate_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "ContactResearchCandidate_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX "ContactResearchJob_artistId_key"
  ON "ContactResearchJob"("artistId");
CREATE UNIQUE INDEX "ContactResearchJob_claimToken_key"
  ON "ContactResearchJob"("claimToken");
CREATE INDEX "ContactResearchJob_status_priority_nextShowAt_createdAt_idx"
  ON "ContactResearchJob"("status", "priority", "nextShowAt", "createdAt");
CREATE INDEX "ContactResearchJob_claimExpiresAt_idx"
  ON "ContactResearchJob"("claimExpiresAt");
CREATE INDEX "ContactResearchJob_requestedShowId_idx"
  ON "ContactResearchJob"("requestedShowId");

CREATE UNIQUE INDEX "ContactResearchCandidate_jobId_normalizedEmail_key"
  ON "ContactResearchCandidate"("jobId", "normalizedEmail");
CREATE INDEX "ContactResearchCandidate_status_createdAt_idx"
  ON "ContactResearchCandidate"("status", "createdAt");

ALTER TABLE "ContactResearchJob"
  ADD CONSTRAINT "ContactResearchJob_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactResearchJob"
  ADD CONSTRAINT "ContactResearchJob_requestedShowId_fkey"
  FOREIGN KEY ("requestedShowId") REFERENCES "Show"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContactResearchCandidate"
  ADD CONSTRAINT "ContactResearchCandidate_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ContactResearchJob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
