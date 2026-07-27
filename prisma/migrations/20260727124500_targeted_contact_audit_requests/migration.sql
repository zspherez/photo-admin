BEGIN;

ALTER TABLE "ContactAuditRequest"
  ADD COLUMN "artistId" TEXT;

ALTER TABLE "ContactAuditRequest"
  DROP CONSTRAINT "ContactAuditRequest_source_check",
  ADD CONSTRAINT "ContactAuditRequest_source_check"
    CHECK ("source" IN (
      'manual',
      'monthly',
      'rolling_monthly',
      'legacy',
      'artist_manual'
    )),
  ADD CONSTRAINT "ContactAuditRequest_targeted_artist_check"
    CHECK ("source" <> 'artist_manual' OR "artistId" IS NOT NULL);

ALTER TABLE "ContactAuditRequest"
ADD CONSTRAINT "ContactAuditRequest_artistId_fkey"
FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ContactAuditRequest_artistId_status_requestedAt_idx"
ON "ContactAuditRequest"("artistId", "status", "requestedAt");

COMMIT;
