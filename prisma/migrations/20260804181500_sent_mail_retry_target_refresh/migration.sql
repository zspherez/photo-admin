BEGIN;

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

CREATE OR REPLACE FUNCTION "protect_arbitrary_email_dispatch_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."providerCredentialScope" IS NOT NULL
     AND NEW."providerCredentialScope" IS DISTINCT FROM OLD."providerCredentialScope" THEN
    RAISE EXCEPTION 'ArbitraryEmail providerCredentialScope is immutable once set';
  END IF;
  IF OLD."firstAttemptAt" IS NOT NULL
     AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt" THEN
    RAISE EXCEPTION 'ArbitraryEmail firstAttemptAt is immutable once set';
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
    RAISE EXCEPTION 'ArbitraryEmail Sent mailbox target is immutable after possible provider acceptance';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
