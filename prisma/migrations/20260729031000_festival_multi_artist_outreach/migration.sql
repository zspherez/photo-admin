BEGIN;

ALTER TYPE "EmailTemplatePurpose"
ADD VALUE IF NOT EXISTS 'festival_multi_artist';

CREATE TABLE "OutreachCoveredArtist" (
  "outreachId" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutreachCoveredArtist_pkey"
    PRIMARY KEY ("outreachId", "artistId")
);

CREATE INDEX "OutreachCoveredArtist_artistId_idx"
ON "OutreachCoveredArtist"("artistId");

ALTER TABLE "OutreachCoveredArtist"
ADD CONSTRAINT "OutreachCoveredArtist_outreachId_fkey"
FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutreachCoveredArtist"
ADD CONSTRAINT "OutreachCoveredArtist_artistId_fkey"
FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
