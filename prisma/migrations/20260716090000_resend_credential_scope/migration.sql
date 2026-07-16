BEGIN;

ALTER TABLE "OutreachSendAttempt"
  ADD COLUMN "providerCredentialScope" TEXT;

COMMENT ON COLUMN "OutreachSendAttempt"."providerCredentialScope" IS
  'Non-secret SHA-256 fingerprint of the Resend API credential used for provider submission';

-- Any unresolved attempt that may already have reached Resend predates scope
-- binding. It cannot safely reuse its idempotency key automatically.
UPDATE "OutreachSendAttempt"
SET
  "status" = 'manual_review',
  "error" = CASE
    WHEN "error" IS NULL
      THEN 'Provider attempt has no provable Resend credential scope; reconcile provider or webhook state before retrying'
    ELSE
      'Provider attempt has no provable Resend credential scope; reconcile provider or webhook state before retrying: '
      || "error"
  END,
  "failureDisposition" = COALESCE("failureDisposition", 'uncertain'),
  "nextAttemptAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "providerCredentialScope" IS NULL
  AND "providerMessageId" IS NULL
  AND (
    "firstAttemptAt" IS NOT NULL
    OR "attemptCount" > 0
    OR "status" = 'sending'
    OR "failureDisposition" IN ('in_flight', 'uncertain')
  )
  AND "status" NOT IN ('accepted', 'delivery_failed', 'legacy_unknown');

UPDATE "Outreach" o
SET
  "status" = 'manual_review',
  "error" = a."error",
  "scheduledFor" = NULL,
  "nextAttemptAt" = NULL,
  "claimedAt" = NULL,
  "claimToken" = NULL
FROM "OutreachSendAttempt" a
WHERE a."outreachId" = o."id"
  AND a."idempotencyKey" = o."idempotencyKey"
  AND a."providerCredentialScope" IS NULL
  AND a."status" = 'manual_review'
  AND o."providerMessageId" IS NULL
  AND o."status" NOT IN ('sent', 'test');

ALTER TABLE "OutreachSendAttempt"
  ADD CONSTRAINT "OutreachSendAttempt_providerCredentialScope_format_check"
  CHECK (
    "providerCredentialScope" IS NULL
    OR "providerCredentialScope" ~ '^resend:key-sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "OutreachSendAttempt_providerCredentialScope_submission_check"
  CHECK (
    "providerCredentialScope" IS NOT NULL
    OR "providerMessageId" IS NOT NULL
    OR (
      "firstAttemptAt" IS NULL
      AND "attemptCount" = 0
      AND "status" <> 'sending'
    )
    OR (
      "status" = 'request_failed'
      AND "failureDisposition" IN ('in_flight', 'uncertain')
    )
    OR "status" IN (
      'manual_review',
      'legacy_unknown',
      'accepted',
      'delivery_failed'
    )
  );

CREATE INDEX "OutreachSendAttempt_providerCredentialScope_idx"
  ON "OutreachSendAttempt"("providerCredentialScope");

-- The scope may be bound once before submission, but can never be cleared or
-- changed afterward. The immutable request already binds the sender/domain.
CREATE OR REPLACE FUNCTION "prevent_outreach_send_attempt_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachId" IS DISTINCT FROM OLD."outreachId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."providerRequest" IS DISTINCT FROM OLD."providerRequest"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."testSend" IS DISTINCT FROM OLD."testSend"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt request identity is immutable';
  END IF;

  IF OLD."providerCredentialScope" IS NOT NULL
    AND NEW."providerCredentialScope"
      IS DISTINCT FROM OLD."providerCredentialScope"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerCredentialScope is immutable once set';
  END IF;

  IF OLD."firstAttemptAt" IS NOT NULL
    AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt firstAttemptAt is immutable once set';
  END IF;

  IF OLD."providerMessageId" IS NOT NULL
    AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerMessageId is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
