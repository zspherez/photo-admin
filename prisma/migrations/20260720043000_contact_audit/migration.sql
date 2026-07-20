BEGIN;

CREATE TABLE "ContactAuditRun" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "contactCount" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactAuditRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditRun_status_check"
    CHECK ("status" IN ('running', 'complete')),
  CONSTRAINT "ContactAuditRun_contactCount_check"
    CHECK ("contactCount" >= 0)
);

CREATE TABLE "ContactAuditJob" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "contactId" TEXT,
  "artistId" TEXT,
  "snapshotArtistName" TEXT NOT NULL,
  "snapshotEmail" TEXT,
  "snapshotPhone" TEXT,
  "snapshotName" TEXT,
  "snapshotRole" TEXT,
  "snapshotSource" TEXT,
  "snapshotNotes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "finding" TEXT,
  "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidence" TEXT,
  "confidence" TEXT,
  "agentNotes" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactAuditJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditJob_status_check"
    CHECK ("status" IN ('pending', 'claimed', 'complete')),
  CONSTRAINT "ContactAuditJob_finding_check"
    CHECK (
      "finding" IS NULL OR
      "finding" IN ('current', 'changed', 'stale', 'ambiguous', 'unverified')
    ),
  CONSTRAINT "ContactAuditJob_confidence_check"
    CHECK (
      "confidence" IS NULL OR
      "confidence" IN ('high', 'medium', 'low')
    ),
  CONSTRAINT "ContactAuditJob_sourceUrls_check"
    CHECK (
      (
        "status" IN ('pending', 'claimed')
        AND cardinality("sourceUrls") = 0
      )
      OR
      (
        "status" = 'complete'
        AND cardinality("sourceUrls") BETWEEN 1 AND 10
      )
    ),
  CONSTRAINT "ContactAuditJob_evidence_length_check"
    CHECK ("evidence" IS NULL OR char_length("evidence") <= 4000),
  CONSTRAINT "ContactAuditJob_agentNotes_length_check"
    CHECK ("agentNotes" IS NULL OR char_length("agentNotes") <= 4000),
  CONSTRAINT "ContactAuditJob_result_consistency_check"
    CHECK (
      (
        "status" IN ('pending', 'claimed')
        AND "finding" IS NULL
        AND "evidence" IS NULL
        AND "confidence" IS NULL
        AND "verifiedAt" IS NULL
      )
      OR
      (
        "status" = 'complete'
        AND "finding" IS NOT NULL
        AND "evidence" IS NOT NULL
        AND "confidence" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
      )
    )
);

CREATE TABLE "ContactAuditAlternative" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "role" TEXT NOT NULL,
  "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidence" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactAuditAlternative_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContactAuditAlternative_role_check"
    CHECK ("role" = 'management'),
  CONSTRAINT "ContactAuditAlternative_confidence_check"
    CHECK ("confidence" IN ('high', 'medium', 'low')),
  CONSTRAINT "ContactAuditAlternative_sourceUrls_check"
    CHECK (cardinality("sourceUrls") BETWEEN 1 AND 5),
  CONSTRAINT "ContactAuditAlternative_evidence_length_check"
    CHECK (char_length("evidence") <= 4000)
);

CREATE INDEX "ContactAuditRun_status_createdAt_idx"
  ON "ContactAuditRun"("status", "createdAt");

CREATE UNIQUE INDEX "ContactAuditJob_claimToken_key"
  ON "ContactAuditJob"("claimToken");
CREATE UNIQUE INDEX "ContactAuditJob_runId_contactId_key"
  ON "ContactAuditJob"("runId", "contactId");
CREATE INDEX "ContactAuditJob_runId_status_createdAt_idx"
  ON "ContactAuditJob"("runId", "status", "createdAt");
CREATE INDEX "ContactAuditJob_status_claimExpiresAt_idx"
  ON "ContactAuditJob"("status", "claimExpiresAt");
CREATE INDEX "ContactAuditJob_finding_reviewedAt_verifiedAt_idx"
  ON "ContactAuditJob"("finding", "reviewedAt", "verifiedAt");
CREATE INDEX "ContactAuditJob_contactId_idx"
  ON "ContactAuditJob"("contactId");
CREATE INDEX "ContactAuditJob_artistId_idx"
  ON "ContactAuditJob"("artistId");

CREATE UNIQUE INDEX "ContactAuditAlternative_jobId_normalizedEmail_key"
  ON "ContactAuditAlternative"("jobId", "normalizedEmail");
CREATE INDEX "ContactAuditAlternative_jobId_createdAt_idx"
  ON "ContactAuditAlternative"("jobId", "createdAt");

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ContactAuditRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContactAuditJob"
  ADD CONSTRAINT "ContactAuditJob_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ContactAuditAlternative"
  ADD CONSTRAINT "ContactAuditAlternative_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ContactAuditJob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
