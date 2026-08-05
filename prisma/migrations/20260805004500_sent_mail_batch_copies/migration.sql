BEGIN;

DROP INDEX "SentMailCopy_outreachAttemptId_key";

ALTER TABLE "SentMailCopy"
ADD COLUMN "requestIndex" INTEGER;

UPDATE "SentMailCopy"
SET "requestIndex" = 0
WHERE "outreachAttemptId" IS NOT NULL;

ALTER TABLE "SentMailCopy"
ADD CONSTRAINT "SentMailCopy_requestIndex_check"
CHECK (
  (
    "outreachAttemptId" IS NOT NULL
    AND "requestIndex" IS NOT NULL
    AND "requestIndex" >= 0
  )
  OR (
    "outreachAttemptId" IS NULL
    AND "requestIndex" IS NULL
  )
);

CREATE UNIQUE INDEX "SentMailCopy_outreachAttemptId_requestIndex_key"
ON "SentMailCopy"("outreachAttemptId", "requestIndex");

CREATE OR REPLACE FUNCTION "prevent_sent_mail_copy_identity_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."outreachAttemptId" IS DISTINCT FROM OLD."outreachAttemptId"
    OR NEW."requestIndex" IS DISTINCT FROM OLD."requestIndex"
    OR NEW."arbitraryEmailId" IS DISTINCT FROM OLD."arbitraryEmailId"
    OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
    OR NEW."targetScope" IS DISTINCT FROM OLD."targetScope"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'SentMailCopy source identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

  IF (
    NEW."sentMailboxCopyRequested"
      IS DISTINCT FROM OLD."sentMailboxCopyRequested"
    OR NEW."sentMailboxTargetScope"
      IS DISTINCT FROM OLD."sentMailboxTargetScope"
    OR NEW."sentMailboxCopyConfigurationError"
      IS DISTINCT FROM OLD."sentMailboxCopyConfigurationError"
  ) AND (
    NULLIF(btrim(OLD."providerMessageId"), '') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(
        COALESCE(OLD."providerMessageIds", ARRAY[]::TEXT[])
      ) AS "providerMessageIdValue"
      WHERE NULLIF(btrim("providerMessageIdValue"), '') IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(OLD."providerRequestResults") = 'array'
            THEN OLD."providerRequestResults"
          ELSE '[]'::JSONB
        END
      ) AS "providerRequestResult"
      WHERE jsonb_typeof("providerRequestResult") = 'object'
        AND NULLIF(
          btrim("providerRequestResult" ->> 'providerMessageId'),
          ''
        ) IS NOT NULL
    )
    OR NOT (
      (
        OLD."firstAttemptAt" IS NULL
        AND OLD."attemptCount" = 0
        AND OLD."status" IN ('prepared', 'queued')
      )
      OR COALESCE(
        OLD."failureDisposition" IN (
          'configuration',
          'retryable',
          'permanent',
          'policy'
        ),
        FALSE
      )
    )
  ) THEN
    RAISE EXCEPTION 'OutreachSendAttempt Sent mailbox target is immutable after possible provider acceptance';
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

  IF NULLIF(btrim(OLD."providerMessageId"), '') IS NOT NULL
    AND NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
  THEN
    RAISE EXCEPTION 'OutreachSendAttempt providerMessageId is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
