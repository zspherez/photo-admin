BEGIN;

ALTER TABLE "ArbitraryEmail"
ADD COLUMN "dismissedAt" TIMESTAMP(3);

CREATE INDEX "ArbitraryEmail_dismissedAt_createdAt_idx"
ON "ArbitraryEmail"("dismissedAt", "createdAt");

COMMIT;
