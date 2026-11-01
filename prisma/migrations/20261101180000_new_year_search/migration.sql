CREATE TABLE "NewYearSearchBatch" (
  "id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NewYearSearchBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NewYearSearchBatch_createdAt_idx" ON "NewYearSearchBatch"("createdAt");
CREATE UNIQUE INDEX "NewYearSearchBatch_active_year_key" ON "NewYearSearchBatch"("year") WHERE "status" IN ('queued', 'running');

CREATE TABLE "NewYearSearchJob" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimedAt" TIMESTAMP(3),
  "claimToken" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  CONSTRAINT "NewYearSearchJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NewYearSearchJob_batchId_artistId_key" ON "NewYearSearchJob"("batchId", "artistId");
CREATE UNIQUE INDEX "NewYearSearchJob_claimToken_key" ON "NewYearSearchJob"("claimToken");
CREATE INDEX "NewYearSearchJob_batchId_status_idx" ON "NewYearSearchJob"("batchId", "status");
ALTER TABLE "NewYearSearchJob" ADD CONSTRAINT "NewYearSearchJob_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "NewYearSearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NewYearSearchJob" ADD CONSTRAINT "NewYearSearchJob_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NewYearSearchSuggestion" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "NewYearSearchSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NewYearSearchSuggestion_jobId_date_city_state_key" ON "NewYearSearchSuggestion"("jobId", "date", "city", "state");
CREATE INDEX "NewYearSearchSuggestion_status_createdAt_idx" ON "NewYearSearchSuggestion"("status", "createdAt");
ALTER TABLE "NewYearSearchSuggestion" ADD CONSTRAINT "NewYearSearchSuggestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "NewYearSearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
