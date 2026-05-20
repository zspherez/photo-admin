-- Festivals: allow Show rows without an EDMTrain id (for manual festivals)
-- and add columns to differentiate festivals from regular shows.

ALTER TABLE "Show" ALTER COLUMN "edmtrainId" DROP NOT NULL;

ALTER TABLE "Show" ADD COLUMN "isFestival" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Show" ADD COLUMN "eventName" TEXT;
ALTER TABLE "Show" ADD COLUMN "source" TEXT;

CREATE INDEX "Show_isFestival_date_idx" ON "Show"("isFestival", "date");
