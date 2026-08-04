BEGIN;

ALTER TABLE "Outreach"
ADD COLUMN "recipientDeliveryMode" TEXT NOT NULL DEFAULT 'individual_threads',
ADD COLUMN "primaryRecipientEmail" TEXT;

ALTER TABLE "Outreach"
ADD CONSTRAINT "Outreach_recipient_delivery_mode_check"
CHECK (
  (
    "recipientDeliveryMode" = 'individual_threads'
    AND "primaryRecipientEmail" IS NULL
  )
  OR (
    "recipientDeliveryMode" = 'cc_thread'
    AND "primaryRecipientEmail" IS NOT NULL
    AND "primaryRecipientEmail" = ANY("recipientEmails")
  )
);

COMMIT;
