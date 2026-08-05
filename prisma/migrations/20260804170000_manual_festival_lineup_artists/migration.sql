BEGIN;

ALTER TABLE "ShowArtist"
ADD COLUMN "providerManaged" BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN "manuallyAdded" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "ShowArtist" AS show_artist
SET
  "providerManaged" = FALSE,
  "manuallyAdded" = TRUE
FROM "Show" AS show
WHERE show."id" = show_artist."showId"
  AND show."source" = 'manual';

ALTER TABLE "ShowArtist"
ADD CONSTRAINT "ShowArtist_ownership_check"
CHECK ("providerManaged" OR "manuallyAdded");

COMMIT;
