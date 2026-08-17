BEGIN;

ALTER TABLE "ShowArtist"
ADD COLUMN "rejectedAt" TIMESTAMP(3);

ALTER TABLE "ShowArtist"
DROP CONSTRAINT "ShowArtist_ownership_check";

ALTER TABLE "ShowArtist"
ADD CONSTRAINT "ShowArtist_ownership_check"
CHECK ("providerManaged" OR "manuallyAdded" OR "rejectedAt" IS NOT NULL);

CREATE INDEX "ShowArtist_showId_rejectedAt_idx"
ON "ShowArtist"("showId", "rejectedAt");

COMMIT;
