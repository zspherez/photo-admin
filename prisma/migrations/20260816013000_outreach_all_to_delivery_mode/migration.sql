BEGIN;

ALTER TABLE "Outreach"
DROP CONSTRAINT "Outreach_recipient_delivery_mode_check";

ALTER TABLE "Outreach"
ADD CONSTRAINT "Outreach_recipient_delivery_mode_check"
CHECK (
  (
    "recipientDeliveryMode" IN (
      'individual_threads',
      'to_thread',
      'legacy_multi_to'
    )
    AND "primaryRecipientEmail" IS NULL
  )
  OR (
    "recipientDeliveryMode" = 'cc_thread'
    AND "primaryRecipientEmail" IS NOT NULL
    AND "primaryRecipientEmail" = ANY("recipientEmails")
  )
);

COMMIT;
