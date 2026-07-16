BEGIN;

-- External IDs, not normalized display names, are authoritative. Keeping an
-- index preserves lookup performance while allowing distinct same-name artists.
DROP INDEX "Artist_normalizedName_key";
CREATE INDEX "Artist_normalizedName_idx" ON "Artist"("normalizedName");

-- Stable Sheet ownership supports exact row/email reconciliation. Outreach
-- history remains intact through the existing Contact -> Outreach SET NULL FK.
ALTER TABLE "Contact"
  ADD COLUMN "sourceKey" TEXT,
  ADD COLUMN "sourceSyncedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Contact_sourceKey_key" ON "Contact"("sourceKey");
CREATE INDEX "Contact_source_idx" ON "Contact"("source");

-- Provider-managed events are tombstoned instead of destructively deleted.
ALTER TABLE "Show"
  ADD COLUMN "syncStatus" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "sourceLastSeenAt" TIMESTAMP(3),
  ADD COLUMN "sourceGeneration" TEXT;

ALTER TABLE "Show"
  ADD CONSTRAINT "Show_syncStatus_check"
  CHECK ("syncStatus" IN ('active', 'cancelled', 'blocked', 'missing'));

UPDATE "Show"
SET "sourceLastSeenAt" = "updatedAt"
WHERE "source" = 'edmtrain';

CREATE INDEX "Show_source_syncStatus_date_idx"
  ON "Show"("source", "syncStatus", "date");

-- Complete snapshots replace ranking/membership signals. Recent-play signals
-- carry an explicit 30-day TTL for consumers that need freshness filtering.
ALTER TABLE "ListenSignal"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "syncGeneration" TEXT;

UPDATE "ListenSignal"
SET "expiresAt" = COALESCE("lastSeenAt", "fetchedAt") + INTERVAL '30 days'
WHERE "source" = 'spotify_recent';

DELETE FROM "ListenSignal"
WHERE "source" = 'spotify_recent'
  AND "expiresAt" <= CURRENT_TIMESTAMP;

CREATE INDEX "ListenSignal_source_expiresAt_idx"
  ON "ListenSignal"("source", "expiresAt");

COMMIT;
