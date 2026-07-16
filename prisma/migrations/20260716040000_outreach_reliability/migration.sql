BEGIN;

-- Contact deletion must not erase outreach history. The old partial unique
-- index could reject SET NULL when an artist-level marker already existed.
DROP INDEX IF EXISTS "Outreach_showId_artistId_null_contact_key";

ALTER TABLE "Outreach" DROP CONSTRAINT "Outreach_contactId_fkey";

-- Add claim, recipient snapshot, and stable provider request state.
ALTER TABLE "Outreach"
  ADD COLUMN "recipientEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "recipientSnapshotState" TEXT NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN "fullTeamSend" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- A legacy recipient snapshot cannot be reconstructed from mutable current
-- contacts or today's full-team flag. Preserve the history as explicitly
-- unknown; the cutover migration quarantines actionable legacy rows.
ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_recipientSnapshotState_check"
  CHECK ("recipientSnapshotState" IN ('verified', 'legacy_unknown'));

-- Any legacy queued/failed row may already have reached the provider. Mark it
-- as attempted so the next migration quarantines it instead of rebuilding a
-- new request under a different idempotency key.
UPDATE "Outreach"
SET
  "attemptCount" = 1,
  "lastAttemptAt" = COALESCE("sentAt", "createdAt")
WHERE "providerMessageId" IS NOT NULL
   OR "status" IN ('queued', 'failed')
   OR (
     "sentAt" IS NOT NULL
     AND NOT (
       "finalSubject" = '(manual outreach)'
       AND "finalHtml" = '(manual outreach)'
     )
   )
   OR "deliveredAt" IS NOT NULL
   OR "openCount" > 0
   OR "clickCount" > 0
   OR "bouncedAt" IS NOT NULL
   OR "complainedAt" IS NOT NULL;

UPDATE "Outreach"
SET "idempotencyKey" = 'outreach/' || "id"
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "Outreach"
  ALTER COLUMN "idempotencyKey"
  SET DEFAULT ('outreach/'::text || md5(((random())::text || (clock_timestamp())::text)));

ALTER TABLE "Outreach" ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "Outreach_idempotencyKey_key" ON "Outreach"("idempotencyKey");
CREATE INDEX "Outreach_status_claimedAt_idx" ON "Outreach"("status", "claimedAt");

ALTER TABLE "Outreach"
  ADD CONSTRAINT "Outreach_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Address-level suppression persists independently of contacts and outreach.
CREATE TABLE "EmailSuppression" (
  "normalizedEmail" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'resend',
  "sourceEventId" TEXT,
  "suppressedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("normalizedEmail")
);

CREATE INDEX "EmailSuppression_suppressedAt_idx" ON "EmailSuppression"("suppressedAt");

-- Suppression backfill is deferred until the attempt migration can distinguish
-- proven real failures from test and unverifiable legacy provider activity.
-- It will use only verified snapshots or provider-reported recipients.

UPDATE "Outreach"
SET
  "status" = 'failed',
  "error" = CASE
    WHEN "complainedAt" IS NOT NULL THEN 'complaint'
    ELSE COALESCE("error", 'bounce:legacy')
  END
WHERE "status" <> 'test'
  AND ("bouncedAt" IS NOT NULL OR "complainedAt" IS NOT NULL)
  -- A later real provider acceptance supersedes stale failure timestamps left
  -- behind by an earlier bounce or test send.
  AND NOT (
    "status" = 'sent'
    AND "sentAt" IS NOT NULL
    AND "sentAt" > GREATEST(
      COALESCE("bouncedAt", '-infinity'::TIMESTAMP),
      COALESCE("complainedAt", '-infinity'::TIMESTAMP)
    )
    AND (
      "providerMessageId" IS NOT NULL
      OR "deliveredAt" IS NOT NULL
      OR "firstOpenedAt" IS NOT NULL
      OR "lastOpenedAt" IS NOT NULL
      OR "openCount" > 0
      OR "firstClickedAt" IS NOT NULL
      OR "lastClickedAt" IS NOT NULL
      OR "clickCount" > 0
    )
  );

-- Svix delivery IDs make webhook retries idempotent.
CREATE TABLE "ResendWebhookEvent" (
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "recipientEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "providerCreatedAt" TIMESTAMP(3) NOT NULL,
  "outreachId" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ResendWebhookEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "ResendWebhookEvent_outreachId_providerCreatedAt_idx"
  ON "ResendWebhookEvent"("outreachId", "providerCreatedAt");

ALTER TABLE "ResendWebhookEvent"
  ADD CONSTRAINT "ResendWebhookEvent_outreachId_fkey"
  FOREIGN KEY ("outreachId") REFERENCES "Outreach"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
