CREATE TABLE "FestivalRunSearchBatch" (
  "id" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FestivalRunSearchBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FestivalRunSearchJob" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimedAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  CONSTRAINT "FestivalRunSearchJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FestivalRunSearchSuggestion" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "festivalName" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "FestivalRunSearchSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FestivalRunSearchBatch_createdAt_idx" ON "FestivalRunSearchBatch"("createdAt");
CREATE UNIQUE INDEX "FestivalRunSearchBatch_active_key" ON "FestivalRunSearchBatch" ((true)) WHERE "status" IN ('queued', 'running');
CREATE UNIQUE INDEX "FestivalRunSearchJob_batchId_artistId_key" ON "FestivalRunSearchJob"("batchId", "artistId");
CREATE UNIQUE INDEX "FestivalRunSearchJob_claimToken_key" ON "FestivalRunSearchJob"("claimToken");
CREATE INDEX "FestivalRunSearchJob_batchId_status_idx" ON "FestivalRunSearchJob"("batchId", "status");
CREATE UNIQUE INDEX "FestivalRunSearchSuggestion_jobId_date_festivalName_key" ON "FestivalRunSearchSuggestion"("jobId", "date", "festivalName");
CREATE INDEX "FestivalRunSearchSuggestion_status_createdAt_idx" ON "FestivalRunSearchSuggestion"("status", "createdAt");

ALTER TABLE "FestivalRunSearchJob"
  ADD CONSTRAINT "FestivalRunSearchJob_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FestivalRunSearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "FestivalRunSearchJob_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FestivalRunSearchSuggestion"
  ADD CONSTRAINT "FestivalRunSearchSuggestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FestivalRunSearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
