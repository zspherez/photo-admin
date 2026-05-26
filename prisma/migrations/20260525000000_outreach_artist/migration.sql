-- Outreach.contactId becomes optional; Outreach.artistId becomes the
-- artist-level anchor so we can mark sent without a known contact.

ALTER TABLE "Outreach" ADD COLUMN "artistId" TEXT;

UPDATE "Outreach" o
SET "artistId" = c."artistId"
FROM "Contact" c
WHERE o."contactId" = c."id";

ALTER TABLE "Outreach" ALTER COLUMN "artistId" SET NOT NULL;
ALTER TABLE "Outreach" ALTER COLUMN "contactId" DROP NOT NULL;

ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_artistId_fkey"
  FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE;

CREATE INDEX "Outreach_artistId_idx" ON "Outreach"("artistId");

-- One artist-level "manual sent" marker per show (contact-less row).
CREATE UNIQUE INDEX "Outreach_showId_artistId_null_contact_key"
  ON "Outreach"("showId", "artistId")
  WHERE "contactId" IS NULL;
