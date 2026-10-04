BEGIN;

ALTER TABLE "Outreach"
  ADD COLUMN "festivalRecipientPartition" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
