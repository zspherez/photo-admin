BEGIN;

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
    NULLIF(
      regexp_replace(
        COALESCE(OLD."providerMessageId", ''),
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
      ),
      ''
    ) IS NOT NULL
    OR NOT (
      (
        OLD."firstAttemptAt" IS NULL
        AND OLD."attemptCount" = 0
        AND (
          OLD."status" = 'queued'
          OR (
            OLD."status" = 'sending'
            AND OLD."claimedAt" IS NULL
            AND OLD."claimToken" IS NULL
          )
        )
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
