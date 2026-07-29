BEGIN;

ALTER TABLE "Outreach"
ADD COLUMN "dismissedAt" TIMESTAMP(3);

CREATE INDEX "Outreach_dismissedAt_createdAt_idx"
ON "Outreach"("dismissedAt", "createdAt");

COMMIT;
