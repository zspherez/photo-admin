BEGIN;

ALTER TABLE "Outreach"
ADD COLUMN "recipientDeliveryMode" TEXT NOT NULL DEFAULT 'individual_threads',
ADD COLUMN "primaryRecipientEmail" TEXT,
ADD COLUMN "providerMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "OutreachSendAttempt"
ADD COLUMN "providerMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "providerRequestResults" JSONB;

DELETE FROM "OutreachSendAttempt" AS attempt
USING "Outreach" AS outreach
WHERE attempt."outreachId" = outreach."id"
  AND cardinality(outreach."recipientEmails") > 1
  AND attempt."status" = 'prepared'
  AND attempt."providerRequest" IS NOT NULL
  AND attempt."providerMessageId" IS NULL
  AND attempt."firstAttemptAt" IS NULL
  AND attempt."attemptCount" = 0;

UPDATE "Outreach"
SET "recipientDeliveryMode" = 'legacy_multi_to'
WHERE cardinality("recipientEmails") > 1
  AND EXISTS (
    SELECT 1
    FROM "OutreachSendAttempt" AS attempt
    WHERE attempt."outreachId" = "Outreach"."id"
      AND attempt."providerRequest" IS NOT NULL
      AND (
        attempt."providerMessageId" IS NOT NULL
        OR attempt."firstAttemptAt" IS NOT NULL
        OR attempt."attemptCount" > 0
        OR attempt."status" IN ('sending', 'accepted', 'delivery_failed')
        OR attempt."failureDisposition" IN ('in_flight', 'uncertain')
      )
  );

ALTER TABLE "Outreach"
ADD CONSTRAINT "Outreach_recipient_delivery_mode_check"
CHECK (
  (
    "recipientDeliveryMode" = 'individual_threads'
    AND "primaryRecipientEmail" IS NULL
  )
  OR (
    "recipientDeliveryMode" = 'legacy_multi_to'
    AND "primaryRecipientEmail" IS NULL
  )
  OR (
    "recipientDeliveryMode" = 'cc_thread'
    AND "primaryRecipientEmail" IS NOT NULL
    AND "primaryRecipientEmail" = ANY("recipientEmails")
  )
);

COMMIT;
